/**
 * 通用重试管理器
 */
class RetryManager {
    constructor(options = {}) {
        this.maxRetries = options.maxRetries || 3;
        this.retryDelay = options.retryDelay || 2000;
        this.backoffMultiplier = options.backoffMultiplier || 1.5;
        this.logger = options.logger || console;
    }

    /**
     * 执行操作并在失败时重试
     * @param {Function} operation - 要执行的异步操作
     * @param {Object} options - 重试选项
     * @returns {Promise<any>}
     */
    async executeWithRetry(operation, options = {}) {
        const maxRetries = options.maxRetries || this.maxRetries;
        const retryDelay = options.retryDelay || this.retryDelay;
        const shouldRetry = options.shouldRetry || (() => true);
        const onRetry = options.onRetry || (() => {});
        
        let lastError;
        let delay = retryDelay;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                
                if (attempt === maxRetries || !shouldRetry(error, attempt)) {
                    throw error;
                }
                
                this.logger.warn(`操作失败，尝试 ${attempt + 1}/${maxRetries}: ${error.message}`);
                onRetry(error, attempt);
                
                await this.delay(delay);
                delay *= this.backoffMultiplier;
            }
        }
        
        throw lastError;
    }

    /**
     * 延迟执行
     * @param {number} ms - 延迟毫秒数
     * @returns {Promise<void>}
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 带超时的操作执行
     * @param {Function} operation - 要执行的异步操作
     * @param {number} timeout - 超时时间（毫秒）
     * @returns {Promise<any>}
     */
    async executeWithTimeout(operation, timeout) {
        return Promise.race([
            operation(),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('操作超时')), timeout)
            )
        ]);
    }

    /**
     * 批量执行操作并处理部分失败
     * @param {Array<Function>} operations - 要执行的操作数组
     * @param {Object} options - 执行选项
     * @returns {Promise<Array>}
     */
    async executeBatch(operations, options = {}) {
        const concurrency = options.concurrency || operations.length;
        const stopOnError = options.stopOnError || false;
        
        const results = [];
        const errors = [];
        
        for (let i = 0; i < operations.length; i += concurrency) {
            const batch = operations.slice(i, i + concurrency);
            const batchResults = await Promise.allSettled(
                batch.map(op => this.executeWithRetry(op, options))
            );
            
            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    results.push(result.value);
                } else {
                    errors.push(result.reason);
                    if (stopOnError) {
                        throw new Error(`批量操作失败: ${result.reason.message}`);
                    }
                }
            }
        }
        
        return { results, errors };
    }
}

module.exports = RetryManager;