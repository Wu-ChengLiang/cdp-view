/**
 * 资源管理器 - 统一管理系统资源的生命周期
 */
class ResourceManager {
    constructor(logger) {
        this.resources = new Map();
        this.cleanupHandlers = new Map();
        this.logger = logger || console;
        this.isShuttingDown = false;
        
        // 注册进程退出事件
        process.once('exit', () => this.cleanup());
        process.once('SIGINT', () => this.gracefulShutdown());
        process.once('SIGTERM', () => this.gracefulShutdown());
    }

    /**
     * 注册资源
     * @param {string} name - 资源名称
     * @param {any} resource - 资源对象
     * @param {Function} cleanupHandler - 清理函数
     */
    register(name, resource, cleanupHandler) {
        if (this.isShuttingDown) {
            throw new Error('系统正在关闭，无法注册新资源');
        }
        
        this.resources.set(name, resource);
        if (cleanupHandler) {
            this.cleanupHandlers.set(name, cleanupHandler);
        }
        
        this.logger.info(`资源已注册: ${name}`);
        return resource;
    }

    /**
     * 获取资源
     * @param {string} name - 资源名称
     * @returns {any}
     */
    get(name) {
        return this.resources.get(name);
    }

    /**
     * 释放指定资源
     * @param {string} name - 资源名称
     */
    async release(name) {
        const resource = this.resources.get(name);
        if (!resource) {
            return;
        }

        const cleanupHandler = this.cleanupHandlers.get(name);
        if (cleanupHandler) {
            try {
                await cleanupHandler(resource);
                this.logger.info(`资源已释放: ${name}`);
            } catch (error) {
                this.logger.error(`释放资源失败 ${name}:`, error);
            }
        }

        this.resources.delete(name);
        this.cleanupHandlers.delete(name);
    }

    /**
     * 释放所有资源
     */
    async releaseAll() {
        const names = Array.from(this.resources.keys()).reverse(); // 后进先出
        
        for (const name of names) {
            await this.release(name);
        }
    }

    /**
     * 优雅关闭
     */
    async gracefulShutdown() {
        if (this.isShuttingDown) {
            return;
        }
        
        this.isShuttingDown = true;
        this.logger.info('开始优雅关闭...');
        
        try {
            await this.releaseAll();
            this.logger.info('所有资源已释放');
            process.exit(0);
        } catch (error) {
            this.logger.error('优雅关闭失败:', error);
            process.exit(1);
        }
    }

    /**
     * 强制清理（用于紧急情况）
     */
    cleanup() {
        if (this.resources.size > 0) {
            this.logger.warn(`强制清理 ${this.resources.size} 个未释放的资源`);
            this.resources.clear();
            this.cleanupHandlers.clear();
        }
    }

    /**
     * 获取资源状态
     */
    getStatus() {
        return {
            count: this.resources.size,
            names: Array.from(this.resources.keys()),
            isShuttingDown: this.isShuttingDown
        };
    }
}

// Chrome进程管理器
class ChromeProcessManager extends ResourceManager {
    constructor(logger) {
        super(logger);
        this.chromeInstances = new Set();
    }

    /**
     * 注册Chrome实例
     */
    registerChrome(name, browser) {
        this.chromeInstances.add(browser);
        
        return this.register(name, browser, async (browser) => {
            try {
                if (browser && browser.isConnected()) {
                    await browser.close();
                }
            } catch (error) {
                // 强制终止进程
                if (browser && browser.process()) {
                    browser.process().kill('SIGKILL');
                }
            } finally {
                this.chromeInstances.delete(browser);
            }
        });
    }

    /**
     * 清理所有Chrome进程
     */
    async cleanupAllChrome() {
        const promises = [];
        
        for (const browser of this.chromeInstances) {
            promises.push(this.closeBrowser(browser));
        }
        
        await Promise.allSettled(promises);
        this.chromeInstances.clear();
    }

    async closeBrowser(browser) {
        try {
            if (browser && browser.isConnected()) {
                await browser.close();
            }
        } catch (error) {
            this.logger.error('关闭Chrome失败:', error);
            if (browser && browser.process()) {
                browser.process().kill('SIGKILL');
            }
        }
    }
}

module.exports = { ResourceManager, ChromeProcessManager };