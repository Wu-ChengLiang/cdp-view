/**
 * CDP (Chrome DevTools Protocol) 管理器
 * 统一管理Chrome浏览器的远程调试连接、屏幕录制等功能
 */

const puppeteer = require('puppeteer');
const axios = require('axios');

class CDPManager {
    constructor(io, logger = console) {
        this.io = io;
        this.logger = logger;
        
        // CDP相关状态
        this.cdpSession = null;
        this.browser = null;
        this.page = null;
        this.screencastActive = false;
        this.frameHandler = null;
        this.lastFrameTime = 0;
        this.frameInterval = 1000 / 20; // 20fps
        this.pendingScreenShareSocket = null;
        this.cdpConnected = false;
        this.connectedPort = null;
        
        // CDP重连控制
        this.cdpRetryCount = 0;
        this.cdpMaxRetries = 10;
        this.cdpRetryTimer = null;
        this.cdpRetryStopped = false;
        this.cdpCleaningUp = false;
    }
    
    /**
     * 获取CDP状态
     */
    getStatus() {
        return {
            connected: this.cdpConnected,
            port: this.connectedPort,
            screencastActive: this.screencastActive,
            hasSession: !!this.cdpSession,
            retryCount: this.cdpRetryCount
        };
    }
    
    /**
     * 连接到Chrome实例
     */
    async connect() {
        // 防止重复连接
        if (this.cdpSession || this.isConnecting) {
            this.logger.log('CDP已连接或正在连接中');
            return;
        }
        
        if (this.cdpRetryCount === 0) {
            this.cdpRetryStopped = false;
        }
        
        try {
            this.isConnecting = true;
            const ports = [9222, 9223];
            
            for (const port of ports) {
                try {
                    this.logger.log(`尝试连接Chrome端口 ${port}...`);
                    
                    const response = await axios.get(`http://localhost:${port}/json/version`, {
                        timeout: 1000
                    });
                    const { webSocketDebuggerUrl } = response.data;
                    
                    this.browser = await puppeteer.connect({
                        browserWSEndpoint: webSocketDebuggerUrl,
                        defaultViewport: null
                    });
                    
                    this.browser.on('disconnected', () => {
                        this.logger.warn('Chrome连接断开');
                        this.cleanup();
                    });
                    
                    const pages = await this.browser.pages();
                    for (const page of pages) {
                        const url = await page.url();
                        if (url.includes('waimai.meituan.com') || url.includes('dianping.com') || url !== 'about:blank') {
                            this.page = page;
                            break;
                        }
                    }
                    
                    if (this.page) {
                        // 创建CDP会话
                        this.cdpSession = await this.page.target().createCDPSession();
                        this.cdpConnected = true;
                        this.connectedPort = port;
                        this.logger.log('✅ CDP会话创建成功');
                        
                        // 设置视口大小
                        await this.setupViewport();
                        
                        // 广播连接成功
                        this.broadcastStatus();
                        
                        // 处理待定的屏幕分享
                        if (this.pendingScreenShareSocket) {
                            this.logger.log('处理待处理的屏幕分享请求');
                            this.startScreencast(this.pendingScreenShareSocket);
                            this.pendingScreenShareSocket = null;
                        }
                        
                        this.cdpRetryCount = 0;
                        this.isConnecting = false;
                        return;
                    }
                    
                } catch (error) {
                    // 继续尝试下一个端口
                    continue;
                }
            }
            
            throw new Error('无法连接到任何Chrome实例');
            
        } catch (error) {
            this.logger.error('CDP连接失败:', error.message);
            this.isConnecting = false;
            
            if (this.cdpRetryStopped) {
                this.logger.log('CDP重连已停止');
                return;
            }
            
            this.cdpRetryCount++;
            
            if (this.cdpRetryCount >= this.cdpMaxRetries) {
                this.logger.error(`❌ CDP连接失败，已达到最大重试次数 (${this.cdpMaxRetries})`);
                this.io.emit('cdp-status', { 
                    connected: false, 
                    message: '无法连接到Chrome，请确保AI客服已启动' 
                });
                return;
            }
            
            // 广播重试状态
            this.io.emit('cdp-status', { 
                connected: false, 
                message: `连接失败，2秒后重试... (${this.cdpRetryCount}/${this.cdpMaxRetries})` 
            });
            
            // 安排重试
            this.cdpRetryTimer = setTimeout(() => {
                if (!this.cdpRetryStopped) {
                    this.connect();
                }
            }, 2000);
        }
    }
    
    /**
     * 设置视口大小
     */
    async setupViewport() {
        if (!this.cdpSession) return;
        
        try {
            await this.cdpSession.send('Emulation.setVisibleSize', {
                width: 1650,
                height: 1100
            });
            
            await this.cdpSession.send('Emulation.setDeviceMetricsOverride', {
                width: 1650,
                height: 1100,
                deviceScaleFactor: 1,
                mobile: false
            });
        } catch (error) {
            this.logger.warn('设置视口失败:', error.message);
        }
    }
    
    /**
     * 开始屏幕录制
     */
    async startScreencast(socket) {
        if (!this.cdpSession || this.screencastActive) {
            return;
        }
        
        try {
            this.logger.log('📹 开始屏幕录制...');
            
            // 先移除可能存在的旧监听器
            if (this.frameHandler) {
                this.cdpSession.off('Page.screencastFrame', this.frameHandler);
                this.frameHandler = null;
            }
            
            // 创建新的帧处理器（带帧率限制）
            this.frameHandler = async (frame) => {
                const now = Date.now();
                const timeSinceLastFrame = now - this.lastFrameTime;
                
                // 帧率限制
                if (timeSinceLastFrame < this.frameInterval) {
                    await this.cdpSession.send('Page.screencastFrameAck', {
                        sessionId: frame.sessionId
                    }).catch(() => {});
                    return;
                }
                
                this.lastFrameTime = now;
                
                // 发送帧数据到客户端
                socket.emit('screen-frame', {
                    type: 'screen-frame',
                    data: frame.data,
                    metadata: frame.metadata,
                    timestamp: now
                });
                
                // 确认帧接收
                await this.cdpSession.send('Page.screencastFrameAck', {
                    sessionId: frame.sessionId
                }).catch(() => {});
            };
            
            // 添加事件监听器
            this.cdpSession.on('Page.screencastFrame', this.frameHandler);
            
            // 启动屏幕录制
            await this.cdpSession.send('Page.startScreencast', {
                format: 'jpeg',
                quality: 75,
                maxWidth: 1650,
                maxHeight: 1100,
                everyNthFrame: 1
            });
            
            this.screencastActive = true;
            this.logger.log('✅ 屏幕录制已启动 (20fps限制)');
            
        } catch (error) {
            this.logger.error('❌ 启动屏幕录制失败:', error);
            this.screencastActive = false;
        }
    }
    
    /**
     * 停止屏幕录制
     */
    async stopScreencast() {
        if (!this.cdpSession || !this.screencastActive) {
            return;
        }
        
        try {
            await this.cdpSession.send('Page.stopScreencast');
            
            if (this.frameHandler) {
                this.cdpSession.off('Page.screencastFrame', this.frameHandler);
                this.frameHandler = null;
            }
            
            this.screencastActive = false;
            this.lastFrameTime = 0;
            this.logger.log('⏹️ 屏幕录制已停止');
            
        } catch (error) {
            this.logger.error('❌ 停止屏幕录制失败:', error);
        }
    }
    
    /**
     * 处理点击事件
     */
    async handleClick(inputData) {
        const { x, y, clickType = 'single' } = inputData;
        const viewport = { width: 1650, height: 1100 };
        const absoluteX = Math.round(x * viewport.width);
        const absoluteY = Math.round(y * viewport.height);
        
        this.logger.log(`🖱️ 处理点击: (${absoluteX}, ${absoluteY}) [${clickType}]`);
        
        try {
            const clickCount = clickType === 'double' ? 2 : 1;
            const events = [];
            
            // 移动鼠标
            events.push({
                method: 'Input.dispatchMouseEvent',
                params: {
                    type: 'mouseMoved',
                    x: absoluteX,
                    y: absoluteY
                }
            });
            
            // 按下和释放
            for (let i = 0; i < clickCount; i++) {
                events.push({
                    method: 'Input.dispatchMouseEvent',
                    params: {
                        type: 'mousePressed',
                        x: absoluteX,
                        y: absoluteY,
                        button: 'left',
                        clickCount: i + 1
                    }
                });
                
                events.push({
                    method: 'Input.dispatchMouseEvent',
                    params: {
                        type: 'mouseReleased',
                        x: absoluteX,
                        y: absoluteY,
                        button: 'left',
                        clickCount: i + 1
                    }
                });
            }
            
            // 批量发送事件
            for (const event of events) {
                await this.cdpSession.send(event.method, event.params).catch(e => {
                    this.logger.error(`CDP事件失败: ${event.method}`, e.message);
                });
            }
            
            this.logger.log(`✅ 点击完成`);
            
        } catch (error) {
            this.logger.error('❌ 点击处理失败:', error);
            throw error;
        }
    }
    
    /**
     * 清理CDP连接
     */
    async cleanup() {
        if (!this.cdpSession && !this.browser && this.cdpConnected === false) {
            this.logger.log('CDP已清理，跳过重复操作');
            return;
        }
        
        if (this.cdpCleaningUp) {
            this.logger.log('CDP正在清理中，跳过');
            return;
        }
        
        this.cdpCleaningUp = true;
        this.logger.log('清理CDP连接...');
        
        // 停止CDP重连
        this.cdpRetryStopped = true;
        if (this.cdpRetryTimer) {
            clearTimeout(this.cdpRetryTimer);
            this.cdpRetryTimer = null;
        }
        
        // 停止屏幕录制
        if (this.screencastActive) {
            await this.stopScreencast();
        }
        
        // 停止CDP会话
        if (this.cdpSession) {
            await this.cdpSession.detach().catch(() => {});
            this.cdpSession = null;
        }
        
        // 断开浏览器连接
        if (this.browser) {
            this.browser.disconnect();
            this.browser = null;
        }
        
        this.page = null;
        this.cdpConnected = false;
        this.connectedPort = null;
        this.cdpRetryCount = 0;
        
        // 广播CDP断开状态
        this.io.emit('cdp-status', { connected: false, message: 'Chrome连接已断开' });
        
        this.cdpCleaningUp = false;
        this.logger.log('CDP连接已清理');
    }
    
    /**
     * 广播当前状态
     */
    broadcastStatus() {
        const serviceType = 'AI客服服务';
        
        if (this.cdpConnected && this.connectedPort) {
            this.io.emit('cdp-status', { 
                connected: true, 
                message: `Chrome连接成功 (${serviceType} - 端口${this.connectedPort})`,
                serviceType: serviceType
            });
        } else {
            this.io.emit('cdp-status', { 
                connected: false, 
                message: '正在连接Chrome...' 
            });
        }
    }
    
    /**
     * 处理屏幕分享请求
     */
    handleScreenShareRequest(socket) {
        if (this.cdpConnected) {
            this.startScreencast(socket);
        } else {
            this.logger.log('CDP尚未连接，等待连接后自动开始屏幕分享');
            this.pendingScreenShareSocket = socket;
            socket.emit('cdp-status', { connected: false, message: '等待Chrome连接...' });
        }
    }
}

module.exports = CDPManager;