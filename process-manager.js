/**
 * 进程管理器 - 增强版进程管理和清理
 * 解决AI客服系统中的进程泄露问题
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

class ProcessManager {
    constructor() {
        this.processes = new Map();
        this.processPids = new Set();
        this.cleanupInProgress = false;
        this.shutdownTimeout = 5000; // 5秒强制终止超时
        this.startLocks = new Map(); // 进程启动锁
    }

    /**
     * 启动子进程并跟踪
     */
    async startProcess(name, command, args = [], options = {}) {
        // 并发控制
        if (this.startLocks.has(name)) {
            throw new Error(`进程 ${name} 正在启动中，请勿重复操作`);
        }
        
        this.startLocks.set(name, true);
        
        try {
            if (this.processes.has(name)) {
                await this.stopProcess(name);
            }

            // 如果是xvfb-run命令，使用固定的显示器:99
            let actualCommand = command;
            let actualArgs = [...args];
            let displayNum = null;
            
            if (command === 'xvfb-run') {
                displayNum = 99; // 使用固定的显示器号
                // 改为直接运行node，设置DISPLAY环境变量
                actualCommand = actualArgs[actualArgs.length - 2]; // 获取node命令
                actualArgs = [actualArgs[actualArgs.length - 1]]; // 获取脚本路径
                options.env = {
                    ...options.env,
                    DISPLAY: `:${displayNum}`
                };
            }

            const proc = spawn(actualCommand, actualArgs, {
                ...options,
                detached: false // 确保子进程不会分离
            });

            // 记录进程信息
            this.processes.set(name, {
                process: proc,
                pid: proc.pid,
                command: actualCommand,
                args: actualArgs,
                startTime: Date.now(),
                childPids: new Set(),
                displayNum: displayNum // 记录使用的显示器编号
            });

            this.processPids.add(proc.pid);

            // 监听进程退出
            proc.on('exit', async (code, signal) => {
                console.log(`进程 ${name} 退出: PID=${proc.pid}, code=${code}, signal=${signal}`);
                
                // 释放显示器
                if (displayNum) {
                    // displayNum已固定为99，无需释放
                }
                
                this.processes.delete(name);
                this.processPids.delete(proc.pid);
                this.startLocks.delete(name);
            });

            // 监听进程错误
            proc.on('error', async (error) => {
                console.error(`进程 ${name} 错误:`, error);
                
                // 释放显示器
                if (displayNum) {
                    // displayNum已固定为99，无需释放
                }
                
                this.processes.delete(name);
                this.processPids.delete(proc.pid);
                this.startLocks.delete(name);
            });

            // 跟踪子进程
            await this.trackChildProcesses(name, proc.pid);

            return proc;
            
        } finally {
            // 确保释放启动锁
            this.startLocks.delete(name);
        }
    }

    /**
     * 跟踪子进程
     */
    async trackChildProcesses(name, parentPid) {
        try {
            const childPids = await this.getChildPids(parentPid);
            const processInfo = this.processes.get(name);
            if (processInfo) {
                childPids.forEach(pid => {
                    processInfo.childPids.add(pid);
                    this.processPids.add(pid);
                });
            }
        } catch (error) {
            console.warn(`跟踪子进程失败: ${error.message}`);
        }
    }

    /**
     * 获取子进程PID列表
     */
    async getChildPids(parentPid) {
        return new Promise((resolve, reject) => {
            exec(`pgrep -P ${parentPid}`, (error, stdout) => {
                if (error) {
                    resolve([]); // 没有子进程
                    return;
                }
                
                const pids = stdout.trim().split('\n')
                    .filter(line => line.trim())
                    .map(line => parseInt(line.trim()))
                    .filter(pid => !isNaN(pid));
                
                resolve(pids);
            });
        });
    }

    /**
     * 停止指定进程
     */
    async stopProcess(name) {
        const processInfo = this.processes.get(name);
        if (!processInfo) {
            return false;
        }

        const { process: proc, pid, childPids, displayNum } = processInfo;

        console.log(`正在停止进程 ${name} (PID: ${pid})`);

        // 1. 优雅关闭主进程
        if (!proc.killed) {
            proc.kill('SIGTERM');
        }

        // 2. 等待进程退出或超时
        const exitPromise = new Promise((resolve) => {
            const timer = setTimeout(() => {
                resolve(false); // 超时
            }, this.shutdownTimeout);

            proc.on('exit', () => {
                clearTimeout(timer);
                resolve(true); // 正常退出
            });
        });

        const gracefulExit = await exitPromise;

        // 3. 如果优雅关闭失败，强制终止
        if (!gracefulExit && !proc.killed) {
            console.log(`进程 ${name} 超时，强制终止`);
            proc.kill('SIGKILL');
        }

        // 4. 清理所有子进程
        await this.cleanupChildProcesses(childPids);
        
        // 5. 释放显示器
        if (displayNum) {
            // displayNum已固定为99，无需释放
        }

        // 6. 从跟踪列表中移除
        this.processes.delete(name);
        this.processPids.delete(pid);
        childPids.forEach(childPid => this.processPids.delete(childPid));
        this.startLocks.delete(name);

        return true;
    }

    /**
     * 清理子进程
     */
    async cleanupChildProcesses(childPids) {
        const pidsToKill = [];
        
        for (const pid of childPids) {
            const isRunning = await this.isProcessRunning(pid);
            if (isRunning) {
                pidsToKill.push(pid);
            }
        }

        if (pidsToKill.length === 0) {
            return;
        }

        console.log(`清理子进程: ${pidsToKill.join(', ')}`);

        // 先尝试SIGTERM
        pidsToKill.forEach(pid => {
            try {
                process.kill(pid, 'SIGTERM');
            } catch (error) {
                console.warn(`无法发送SIGTERM给进程 ${pid}: ${error.message}`);
            }
        });

        // 等待2秒后强制终止
        await new Promise(resolve => setTimeout(resolve, 2000));

        for (const pid of pidsToKill) {
            const isStillRunning = await this.isProcessRunning(pid);
            if (isStillRunning) {
                try {
                    process.kill(pid, 'SIGKILL');
                    console.log(`强制终止进程 ${pid}`);
                } catch (error) {
                    console.warn(`无法强制终止进程 ${pid}: ${error.message}`);
                }
            }
        }
    }

    /**
     * 检查进程是否还在运行
     */
    async isProcessRunning(pid) {
        return new Promise((resolve) => {
            exec(`ps -p ${pid}`, (error) => {
                resolve(!error);
            });
        });
    }

    /**
     * 获取Chrome进程列表
     */
    async getChromeProcesses() {
        return new Promise((resolve) => {
            exec('ps aux | grep chrome | grep -v grep', (error, stdout) => {
                if (error) {
                    resolve([]);
                    return;
                }

                const processes = stdout.trim().split('\n')
                    .filter(line => line.trim())
                    .map(line => {
                        const parts = line.trim().split(/\s+/);
                        return {
                            pid: parseInt(parts[1]),
                            cmd: parts.slice(10).join(' ')
                        };
                    });

                resolve(processes);
            });
        });
    }

    /**
     * 强制清理所有Chrome进程
     */
    async forceCleanupChrome() {
        const chromeProcesses = await this.getChromeProcesses();
        
        for (const proc of chromeProcesses) {
            // 只清理由我们启动的Chrome进程
            if (proc.cmd.includes('--remote-debugging-port=9222') || 
                proc.cmd.includes('--remote-debugging-port=9223')) {
                try {
                    process.kill(proc.pid, 'SIGKILL');
                    console.log(`强制终止Chrome进程 ${proc.pid}`);
                } catch (error) {
                    console.warn(`无法终止Chrome进程 ${proc.pid}: ${error.message}`);
                }
            }
        }
    }

    /**
     * 停止所有进程
     */
    async stopAllProcesses() {
        if (this.cleanupInProgress) {
            return;
        }

        this.cleanupInProgress = true;
        console.log('开始清理所有进程...');

        // 停止所有跟踪的进程
        const processNames = Array.from(this.processes.keys());
        for (const name of processNames) {
            await this.stopProcess(name);
        }

        // 额外清理Chrome进程
        await this.forceCleanupChrome();

        // 清理任何残留的已知进程
        await this.cleanupOrphanedProcesses();
        
        // 清理所有Xvfb显示器
        // xvfb使用固定显示器:99，无需特殊清理

        this.cleanupInProgress = false;
        console.log('所有进程清理完成');
    }

    /**
     * 清理孤儿进程
     */
    async cleanupOrphanedProcesses() {
        const patterns = [
            'ai客服.js',
            'aireply.py',
            'python.*aireply.py',
            'xvfb-run'
        ];

        for (const pattern of patterns) {
            await this.killProcessByPattern(pattern);
        }
    }

    /**
     * 根据模式杀死进程
     */
    async killProcessByPattern(pattern) {
        return new Promise((resolve) => {
            exec(`pkill -f "${pattern}"`, (error) => {
                if (error) {
                    // 进程不存在或已经被杀死
                    resolve();
                    return;
                }
                console.log(`清理匹配进程: ${pattern}`);
                resolve();
            });
        });
    }

    /**
     * 获取进程状态
     */
    getProcessStatus() {
        const status = {};
        
        for (const [name, info] of this.processes) {
            status[name] = {
                pid: info.pid,
                running: !info.process.killed,
                uptime: Date.now() - info.startTime,
                childCount: info.childPids.size
            };
        }

        return status;
    }

    /**
     * 健康检查
     */
    async healthCheck() {
        const status = this.getProcessStatus();
        const chromeProcesses = await this.getChromeProcesses();
        const xvfbStatus = { activeDisplays: [99], processCount: 1 }; // 固定显示器状态
        
        return {
            processes: status,
            chromeProcessCount: chromeProcesses.length,
            totalTrackedPids: this.processPids.size,
            cleanupInProgress: this.cleanupInProgress,
            xvfbDisplays: xvfbStatus,
            activeLocks: Array.from(this.startLocks.keys())
        };
    }
}

module.exports = ProcessManager;