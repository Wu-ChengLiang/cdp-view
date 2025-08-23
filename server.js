/**
 * 便携小客服 - 统一服务器入口
 * 提供Web界面和API接口
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');
const ProcessManager = require('./lib/process-manager');
const puppeteer = require('puppeteer');
const axios = require('axios');
const redis = require('redis');
const { SOCKET_CONFIG, CDP_CONFIG, TIMEOUTS } = require('./lib/constants');
const CDPManager = require('./lib/CDPManager');

class CustomerServiceServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            },
            pingTimeout: SOCKET_CONFIG.PING_TIMEOUT,
            pingInterval: SOCKET_CONFIG.PING_INTERVAL,
            connectTimeout: SOCKET_CONFIG.CONNECT_TIMEOUT,
            reconnection: true,
            reconnectionAttempts: SOCKET_CONFIG.RECONNECTION_ATTEMPTS,
            reconnectionDelay: SOCKET_CONFIG.RECONNECTION_DELAY,
            reconnectionDelayMax: SOCKET_CONFIG.RECONNECTION_DELAY_MAX,
            // 启用压缩以减少传输数据量
            perMessageDeflate: {
                threshold: 1024, // 只压缩大于1KB的消息
                zlibDeflateOptions: {
                    level: 6 // 压缩级别(1-9)，6是平衡速度和压缩率
                }
            }
        });
        
        // 进程管理
        this.processes = new Map();
        this.processManager = new ProcessManager();
        this.processStatus = {
            customerService: { running: false, pid: null },
            analysis: { running: false, pid: null }
        };
        
        // CDP管理器
        this.cdpManager = new CDPManager(this.io, console);
        
        // 关闭状态
        this.isShuttingDown = false;
        
        // 最后一次客户端连接时间
        this.lastClientConnectionTime = null;

        // Redis 可用性状态
        this.redisAvailable = null;
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
        
        // 启动定期清理任务
        this.startCleanupTasks();
    }
    
    startCleanupTasks() {
        // 每5分钟检查并清理孤儿进程
        setInterval(async () => {
            try {
                // 清理孤儿Xvfb进程
                if (process.platform === 'linux') {
                    const { exec } = require('child_process');
                    
                    // 获取所有xvfb进程
                    exec('ps aux | grep -E "xvfb-run|Xvfb" | grep -v grep', (error, stdout) => {
                        if (!error && stdout) {
                            const lines = stdout.trim().split('\n');
                            const orphanCount = lines.filter(line => {
                                // 检查是否是孤儿进程（父进程ID为1）
                                return line.includes(' 1 ') && line.includes('Xvfb');
                            }).length;
                            
                            if (orphanCount > 0) {
                                console.log(`发现 ${orphanCount} 个孤儿Xvfb进程，正在清理...`);
                                exec('pkill -f "Xvfb.*-auth /tmp/xvfb-run"', (err) => {
                                    if (!err) {
                                        console.log('孤儿Xvfb进程已清理');
                                    }
                                });
                            }
                        }
                    });
                }
                
                // 检查进程状态一致性
                await this.checkProcessStatusConsistency();
                
            } catch (error) {
                console.error('清理任务出错:', error);
            }
        }, 5 * 60 * 1000); // 5分钟
    }
    
    async checkProcessStatusConsistency() {
        // 检查客服服务状态
        if (this.processStatus.customerService.running) {
            const proc = this.processes.get('customer-service');
            if (!proc || proc.killed) {
                console.log('检测到客服服务状态不一致，正在更新...');
                this.processStatus.customerService = { running: false, pid: null };
                this.processes.delete('customer-service');
            }
        }
        
        // 检查分析服务状态
        if (this.processStatus.analysis.running) {
            const proc = this.processes.get('analysis');
            if (!proc || proc.killed) {
                console.log('检测到分析服务状态不一致，正在更新...');
                this.processStatus.analysis = { running: false, pid: null };
                this.processes.delete('analysis');
            }
        }
    }
    
    setupMiddleware() {
        this.app.use(express.json());
        
        // 服务静态资源目录
        this.app.use('/static', express.static(path.join(__dirname, 'static')));
        
        // 服务主站资源
        this.app.use('/main-site', express.static(path.join(__dirname, 'main-site')));
        
        // 服务AI客服页面在 /ai 路径下
        this.app.use('/ai', express.static(path.join(__dirname, 'ai')));
        
        // 服务根目录的特定文件（排除index.html）
        this.app.use(express.static(__dirname, {
            index: false,  // 不使用index.html作为默认
            dotfiles: 'ignore',  // 忽略点文件
            extensions: ['js', 'css']  // 只服务特定扩展名的文件
        }));
    }
    
    setupRoutes() {
        // 主页路由 - 服务新的主站首页
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'main-site', 'index.html'));
        });
        
        // AI客服页面路由
        this.app.get('/ai', (req, res) => {
            res.sendFile(path.join(__dirname, 'ai', 'index.html'));
        });
        
        // 注册CDP适配器路由
        // CDP状态路由
        this.app.get('/api/cdp/status', (req, res) => {
            const status = this.cdpManager.getStatus();
            res.json({
                mode: 'legacy',
                legacy: {
                    enabled: true,
                    active: status.connected,
                    ...status
                },
                new: {
                    enabled: false,
                    active: false,
                    connected: false
                }
            });
        });
        
        // 健康检查
        this.app.get('/api/health', async (req, res) => {
            const processHealth = await this.processManager.healthCheck();
            // 获取CDP状态
            const cdpStatus = this.cdpManager.getStatus();
            const actualConnected = cdpStatus.connected;
            const actualSession = cdpStatus.hasSession;
            
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                processes: this.processStatus,
                processManager: processHealth,
                cdp: {
                    connected: actualConnected,
                    session: actualSession,
                    adapter: cdpStatus
                }
            });
        });
        
        // 获取进程状态
        this.app.get('/api/status', (req, res) => {
            res.json(this.processStatus);
        });
        
        // 进程管理API
        this.app.get('/api/processes', async (req, res) => {
            const processHealth = await this.processManager.healthCheck();
            res.json(processHealth);
        });
        
        this.app.post('/api/processes/cleanup', async (req, res) => {
            try {
                await this.processManager.stopAllProcesses();
                res.json({ success: true, message: '所有进程已清理' });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
        
        // 启动AI客服
        this.app.post('/api/service/start', async (req, res) => {
            try {
                // 检查是否已有运行中的进程
                if (this.processStatus.customerService.running) {
                    // 检查进程是否真的在运行
                    const proc = this.processes.get('customer-service');
                    if (proc && !proc.killed) {
                        return res.status(400).json({ 
                            error: '客服服务已在运行',
                            pid: this.processStatus.customerService.pid 
                        });
                    }
                    // 如果进程已死但状态未更新，清理状态
                    this.processStatus.customerService = { running: false, pid: null };
                    this.processes.delete('customer-service');
                }
                
                const config = req.body;
                console.log('启动AI客服，配置:', config);
                
                const scriptPath = path.join(__dirname, 'ai客服.js');
                
                // 根据平台选择启动方式
                const isLinux = process.platform === 'linux';
                let command, args;
                
                if (isLinux) {
                    // Linux下使用xvfb-run来提供虚拟显示，设置更大的屏幕尺寸
                    command = 'xvfb-run';
                    args = ['-a', '-s', '-screen 0 1920x1200x24', 'node', scriptPath];
                } else {
                    // Windows/Mac直接使用node
                    command = 'node';
                    args = [scriptPath];
                }
                
                const proc = await this.processManager.startProcess('customer-service', command, args, {
                    env: {
                        ...process.env,
                        MAX_CONTACTS: config.maxContacts || 3
                    }
                });
                
                // 立即尝试连接CDP，如果失败会自动重试
                this.cdpManager.connect();
                
                proc.on('error', (error) => {
                    console.error('AI客服启动失败:', error);
                    this.processStatus.customerService = { running: false, pid: null };
                    this.io.emit('service-error', { type: 'customer-service', error: error.message });
                });
                
                proc.on('exit', async (code) => {
                    console.log(`AI客服进程退出，代码: ${code}`);
                    this.processStatus.customerService = { running: false, pid: null };
                    this.processes.delete('customer-service');
                    
                    // 清理CDP连接
                    await this.cdpManager.cleanup();
                    
                    // 清理可能残留的Xvfb进程
                    if (isLinux) {
                        const { exec } = require('child_process');
                        exec('pkill -f "xvfb-run.*ai客服"', (error) => {
                            if (!error) {
                                console.log('已清理残留的Xvfb进程');
                            }
                        });
                    }
                    
                    this.io.emit('service-stopped', { type: 'customer-service' });
                });
                
                proc.stdout.on('data', (data) => {
                    const message = data.toString().trim();
                    console.log('[AI客服]:', message);
                    this.io.emit('service-log', { type: 'customer-service', message });
                });
                
                this.processes.set('customer-service', proc);
                this.processStatus.customerService = { running: true, pid: proc.pid };
                
                // 广播状态更新
                this.io.emit('status-update', this.processStatus);
                console.log('AI客服已启动，广播状态更新:', this.processStatus);
                
                // 广播CDP连接状态
                this.io.emit('cdp-status', { connected: false, message: '正在连接Chrome...' });
                
                // 播放启动音效
                this.io.emit('play-sound', { type: 'start' });
                
                res.json({ 
                    success: true, 
                    pid: proc.pid,
                    message: '客服服务启动成功'
                });
                
            } catch (error) {
                console.error('启动客服失败:', error);
                res.status(500).json({ error: error.message });
            }
        });
        
        // 启动分析脚本
        this.app.post('/api/analysis/start', async (req, res) => {
            try {
                // 检查是否已有运行中的进程
                if (this.processStatus.analysis.running) {
                    // 检查进程是否真的在运行
                    const proc = this.processes.get('analysis');
                    if (proc && !proc.killed) {
                        return res.status(400).json({ 
                            error: '分析服务已在运行',
                            pid: this.processStatus.analysis.pid 
                        });
                    }
                    // 如果进程已死但状态未更新，清理状态
                    this.processStatus.analysis = { running: false, pid: null };
                    this.processes.delete('analysis');
                }
                
                // 检查AI客服是否正在运行
                if (this.processStatus.customerService.running) {
                    return res.status(400).json({ error: '请先停止AI客服系统，分析脚本与AI客服互斥运行' });
                }
                
                console.log('启动分析脚本（独立Chrome实例，端口9222）');
                
                const scriptPath = path.join(__dirname, '抽取脚本.js');
                
                // 根据平台选择启动方式（与AI客服保持一致）
                const isLinux = process.platform === 'linux';
                let command, args;
                
                if (isLinux) {
                    // Linux下使用xvfb-run来提供虚拟显示，与AI客服保持一致
                    command = 'xvfb-run';
                    args = ['-a', '-s', '-screen 0 1920x1200x24', 'node', scriptPath];
                } else {
                    // Windows/Mac直接使用node
                    command = 'node';
                    args = [scriptPath];
                }
                
                const proc = spawn(command, args, {
                    env: {
                        ...process.env
                        // 移除CHROME_WS环境变量，抽取脚本会启动独立实例
                    }
                });
                
                proc.on('error', (error) => {
                    console.error('分析脚本启动失败:', error);
                    this.processStatus.analysis = { running: false, pid: null };
                    this.io.emit('service-error', { type: 'analysis', error: error.message });
                });
                
                proc.on('exit', async (code) => {
                    console.log(`分析脚本进程退出，代码: ${code}`);
                    this.processStatus.analysis = { running: false, pid: null };
                    this.processes.delete('analysis');
                    
                    // 清理CDP连接
                    await this.cdpManager.cleanup();
                    
                    // 清理可能残留的Xvfb进程
                    if (isLinux) {
                        const { exec } = require('child_process');
                        exec('pkill -f "xvfb-run.*抽取脚本"', (error) => {
                            if (!error) {
                                console.log('已清理残留的Xvfb进程');
                            }
                        });
                    }
                    
                    this.io.emit('service-stopped', { type: 'analysis' });
                });
                
                proc.stdout.on('data', (data) => {
                    const message = data.toString().trim();
                    console.log('[分析脚本]:', message);
                    
                    // 检查是否是报告完成消息（支持多行消息）
                    if (message.includes('REPORT_READY:')) {
                        const reportMatch = message.match(/REPORT_READY:(.+)/);
                        if (reportMatch) {
                            const filename = reportMatch[1];
                            console.log(`📄 报告生成完成: ${filename}`);
                            
                            // 通过WebSocket通知前端报告已完成，可以下载
                            this.io.emit('report-ready', { 
                                filename: filename,
                                downloadUrl: `/api/reports/download/${filename}`,
                                message: '数据分析报告已生成完成，开始自动下载...'
                            });
                            
                            // 自动转换为JPG格式
                            const htmlPath = path.join(__dirname, 'logs', filename);
                            const jpgFilename = filename.replace('.html', '.jpg');
                            const jpgPath = path.join(__dirname, 'logs', jpgFilename);
                            
                            console.log('🔄 开始转换HTML为JPG格式...');
                            const { convertHtmlToJpg } = require('./html2jpg');
                            
                            convertHtmlToJpg(htmlPath, jpgPath)
                                .then(() => {
                                    console.log(`✅ JPG转换完成: ${jpgFilename}`);
                                    
                                    // 通知前端JPG版本已准备好
                                    this.io.emit('jpg-ready', {
                                        filename: jpgFilename,
                                        downloadUrl: `/api/reports/download/${jpgFilename}`,
                                        originalFilename: filename,
                                        message: 'JPG版本已生成，开始自动下载...'
                                    });
                                })
                                .catch(error => {
                                    console.error('❌ JPG转换失败:', error.message);
                                });
                        }
                    }
                    
                    this.io.emit('service-log', { type: 'analysis', message });
                });
                
                this.processes.set('analysis', proc);
                this.processStatus.analysis = { running: true, pid: proc.pid };
                
                // 广播状态更新
                this.io.emit('status-update', this.processStatus);
                console.log('分析脚本已启动，广播状态更新:', this.processStatus);
                
                // 广播CDP连接状态
                this.io.emit('cdp-status', { connected: false, message: '正在连接Chrome...' });
                
                // 等待一段时间后尝试连接CDP（给抽取脚本时间启动Chrome）
                setTimeout(() => {
                    this.cdpManager.connect();
                }, 3000); // 3秒延迟，等待Chrome启动
                
                res.json({ 
                    success: true, 
                    pid: proc.pid,
                    message: '分析服务启动成功'
                });
                
            } catch (error) {
                console.error('启动分析失败:', error);
                res.status(500).json({ error: error.message });
            }
        });
        
        // 停止服务
        this.app.post('/api/service/stop', async (req, res) => {
            try {
                const { type } = req.body;
                
                if (!['customer-service', 'analysis'].includes(type)) {
                    return res.status(400).json({ error: '无效的服务类型' });
                }
                
                const proc = this.processes.get(type);
                if (!proc) {
                    return res.status(400).json({ error: '服务未运行' });
                }
                
                proc.kill('SIGTERM');
                this.processes.delete(type);
                
                if (type === 'customer-service') {
                    this.processStatus.customerService = { running: false, pid: null };
                    // 清理CDP连接
                    await this.cdpManager.cleanup();
                    
                    // 等待进程退出（给AI客服时间清理）
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // 强制清理可能残留的Chrome进程
                    console.log('🧹 清理可能残留的Chrome进程...');
                    await this.processManager.forceCleanupChrome();
                    
                } else {
                    this.processStatus.analysis = { running: false, pid: null };
                    // 清理CDP连接
                    await this.cdpManager.cleanup();
                    
                    // 等待进程退出（给分析脚本时间清理）
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // 强制清理可能残留的Chrome进程
                    console.log('🧹 清理可能残留的Chrome进程...');
                    await this.processManager.forceCleanupChrome();
                }
                
                // 广播状态更新
                this.io.emit('status-update', this.processStatus);
                console.log('服务已停止，广播状态更新:', this.processStatus);
                
                res.json({ success: true, message: '服务已停止' });
                
            } catch (error) {
                console.error('停止服务失败:', error);
                res.status(500).json({ error: error.message });
            }
        });
        
        // 下载报告API
        this.app.get('/api/reports/download/:filename', (req, res) => {
            try {
                const filename = req.params.filename;
                const filePath = path.join(__dirname, 'logs', filename);
                
                // 安全检查：确保文件名是有效的报告文件
                if (!filename.startsWith('数据分析报告_') || (!filename.endsWith('.html') && !filename.endsWith('.jpg'))) {
                    return res.status(400).json({ error: '无效的报告文件名' });
                }
                
                // 检查文件是否存在
                if (!require('fs').existsSync(filePath)) {
                    return res.status(404).json({ error: '报告文件不存在' });
                }
                
                // 设置下载头
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                
                // 发送文件
                res.sendFile(filePath);
                
            } catch (error) {
                console.error('下载报告失败:', error);
                res.status(500).json({ error: error.message });
            }
        });
        
        // 主页面
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'index.html'));
        });
        
        // 处理前端路由
        this.app.get('*', (req, res) => {
            if (req.path.startsWith('/api')) {
                return res.status(404).json({ error: 'API接口不存在' });
            }
            res.sendFile(path.join(__dirname, 'index.html'));
        });
    }
    
    setupWebSocket() {
        this.io.on('connection', (socket) => {
            // 只在第一次连接或长时间断开后重连时记录
            if (!this.lastClientConnectionTime || 
                Date.now() - this.lastClientConnectionTime > 10000) {
                console.log('客户端连接:', socket.id);
                this.lastClientConnectionTime = Date.now();
            }
            
            
            // 发送当前状态
            socket.emit('status-update', this.processStatus);
            
            // 发送当前CDP状态
            this.cdpManager.broadcastStatus();
            
            // 测试连接处理
            socket.on('test-connection', (data) => {
                console.log('🧪 收到测试连接:', data);
                socket.emit('test-response', { message: '服务器连接正常' });
            });
            
            // 调试：列出所有事件监听器
            console.log('🔍 为Socket设置事件监听器，Socket ID:', socket.id);
            console.log('📝 已注册的事件:', socket.eventNames());
            
            // 捕获所有事件进行调试
            const originalEmit = socket.emit;
            socket.emit = function(...args) {
                if (args[0] !== 'screen-frame') { // 避免屏幕帧日志过多
                    console.log('📡 服务器发送事件:', args[0], typeof args[1] === 'object' ? JSON.stringify(args[1]).substring(0, 100) : args[1]);
                }
                return originalEmit.apply(this, args);
            };
            
            // 捕获所有来自客户端的事件
            socket.onAny((eventName, ...args) => {
                console.log('📥 收到客户端事件:', eventName, args);
            });
            
            // 处理客户端断开连接
            socket.on('disconnect', (reason) => {
                // 只记录非正常断开
                if (reason !== 'client namespace disconnect' && reason !== 'server namespace disconnect') {
                    console.log('客户端断开连接:', socket.id, '原因:', reason);
                }

                // CDP连接保持，不基于客户端数量清理
                // 只有在AI客服服务停止或Chrome断开时才清理CDP连接
            });
            
            // 处理屏幕分享请求
            socket.on('start-screen-share', () => {
                console.log('请求开始屏幕分享');
                this.cdpManager.handleScreenShareRequest(socket);
            });
            
            socket.on('stop-screen-share', () => {
                console.log('请求停止屏幕分享');
                this.cdpManager.stopScreencast();
            });
            
            // 处理CDP输入事件（点击）
            socket.on('cdp-input', async (inputData) => {
                console.log('📥 收到CDP输入事件:', inputData);
                
                const status = this.cdpManager.getStatus();
                if (!status.hasSession) {
                    console.log('❌ CDP会话不可用');
                    socket.emit('cdp-error', { message: 'CDP会话不可用' });
                    return;
                }
                
                try {
                    await this.cdpManager.handleClick(inputData);
                } catch (error) {
                    console.error('CDP输入处理错误:', error);
                    socket.emit('cdp-error', { message: error.message });
                }
            });
        });
    }
    
    async start(port = 1200) {
        // CDP已内置到server.js中
        console.log('✅ CDP功能已启用，模式: legacy');
        
        this.server.listen(port, () => {
            console.log(`🚀 便携小客服后端启动成功: http://localhost:${port}`);
            console.log(`🏠 主站首页: http://localhost:${port}/`);
            console.log(`🤖 AI客服系统: http://localhost:${port}/ai`);
            console.log(`📊 API文档: http://localhost:${port}/api/health`);
            console.log(`🔧 CDP模式: legacy`);

            // 异步检测 Redis 连接情况
            this.checkRedisConnection();
        });
    }

    /**
     * 检测 Redis 是否可用，并输出日志
     */
    async checkRedisConnection(url = process.env.REDIS_URL || 'redis://localhost:6379') {
        try {
            const client = redis.createClient({
                url,
                socket: {
                    connectTimeout: 3000,
                    reconnectStrategy: false
                }
            });

            await client.connect();
            await client.ping();

            console.log(`✅ Redis已连接: ${url}`);
            this.redisAvailable = true;

            await client.quit();
        } catch (error) {
            console.warn(`⚠️ 无法连接Redis (${url}): ${error.message}`);
            this.redisAvailable = false;
        }
    }
    
    // 优雅关闭
    async shutdown() {
        if (this.isShuttingDown) {
            return; // 防止重复关闭
        }
        
        this.isShuttingDown = true;
        console.log('正在关闭服务器...');
        
        try {
            // 1. 先停止接受新连接，广播关闭消息
            if (this.io) {
                this.io.emit('server-shutdown', { message: '服务器正在关闭...' });
                // 等待消息发送
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            // 2. 清理CDP
            await this.cdpManager.cleanup();
            
            // 3. 停止所有子进程
            for (const [name, proc] of this.processes) {
                console.log(`停止进程: ${name}`);
                if (proc && !proc.killed) {
                    proc.kill('SIGTERM');
                    
                    // 等待子进程关闭
                    await new Promise((resolve) => {
                        const timer = setTimeout(resolve, 2000); // 2秒超时
                        proc.on('exit', () => {
                            clearTimeout(timer);
                            resolve();
                        });
                    });
                }
            }
            
            // 3.5. 强制清理Chrome进程
            console.log('🧹 清理所有Chrome进程...');
            await this.processManager.forceCleanupChrome();
            
            // 4. 关闭Socket.IO服务器
            if (this.io) {
                await new Promise((resolve) => {
                    this.io.close(() => {
                        console.log('Socket.IO服务器已关闭');
                        resolve();
                    });
                });
            }
            
            // 5. 关闭HTTP服务器
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('关闭服务器超时'));
                }, 3000);
                
                this.server.close((err) => {
                    clearTimeout(timer);
                    if (err) {
                        console.error('关闭服务器时出错:', err);
                        reject(err);
                    } else {
                        console.log('服务器已关闭');
                        resolve();
                    }
                });
            });
            
            console.log('✅ 服务器优雅关闭完成');
            process.exit(0);
            
        } catch (error) {
            console.error('关闭过程中出错:', error);
            console.log('⚠️ 使用强制退出');
            process.exit(1);
        }
    }
}

// 启动服务器
const server = new CustomerServiceServer();
(async () => {
    await server.start();
})();

// 处理进程信号
let shutdownInProgress = false;

process.on('SIGINT', () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log('\n收到SIGINT信号，正在关闭...');
    server.shutdown();
});

process.on('SIGTERM', () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log('\n收到SIGTERM信号，正在关闭...');
    server.shutdown();
});

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
    console.error('未捕获的异常:', error);
    if (!shutdownInProgress) {
        shutdownInProgress = true;
        server.shutdown();
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的 Promise 拒绝:', reason);
    if (!shutdownInProgress) {
        shutdownInProgress = true;
        server.shutdown();
    }
});

module.exports = CustomerServiceServer;