/**
 * 系统常量定义
 */

// Socket.IO配置
exports.SOCKET_CONFIG = {
    PING_TIMEOUT: 60000,
    PING_INTERVAL: 25000,
    CONNECT_TIMEOUT: 45000,
    RECONNECTION_ATTEMPTS: 3,
    RECONNECTION_DELAY: 1000,
    RECONNECTION_DELAY_MAX: 5000
};

// CDP配置
exports.CDP_CONFIG = {
    DEFAULT_PORT: 9222,
    PORTS: [9222, 9223, 9224],
    CONNECTION_TIMEOUT: 5000,
    RETRY_DELAY: 2000,
    MAX_RETRIES: 3
};

// Chrome启动参数
exports.CHROME_ARGS = {
    // 基础参数
    basic: [
        '--allow-pre-commit-input',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-crash-reporter',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-infobars',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-renderer-backgrounding',
        '--disable-search-engine-choice-screen',
        '--disable-sync',
        '--enable-automation',
        '--export-tagged-pdf',
        '--force-color-profile=srgb',
        '--generate-pdf-document-outline',
        '--metrics-recording-only',
        '--no-first-run',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes,VizDisplayCompositor',
        '--enable-features=PdfOopif'
    ],
    
    // 安全参数
    security: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security'
    ],
    
    // 性能参数
    performance: [
        '--disable-gpu',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows'
    ],
    
    // 显示参数
    display: [
        '--window-size=1650,1100',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-blink-features=AutomationControlled'
    ],
    
    // Linux特定参数
    linux: [
        '--disable-dbus'
    ],
    
    // 无头模式参数
    headless: [
        '--headless=new'
    ]
};

// 系统超时配置
exports.TIMEOUTS = {
    PROCESS_KILL: 2000,
    PAGE_LOAD: 30000,
    ELEMENT_WAIT: 10000,
    CDP_CONNECTION: 5000,
    REDIS_CONNECTION: 5000
};

// 日志级别
exports.LOG_LEVELS = {
    ERROR: 'error',
    WARN: 'warn',
    INFO: 'info',
    DEBUG: 'debug'
};

// 错误代码
exports.ERROR_CODES = {
    CDP_CONNECTION_FAILED: 'CDP_CONNECTION_FAILED',
    CHROME_LAUNCH_FAILED: 'CHROME_LAUNCH_FAILED',
    PAGE_RECOVERY_FAILED: 'PAGE_RECOVERY_FAILED',
    REDIS_CONNECTION_FAILED: 'REDIS_CONNECTION_FAILED',
    PROCESS_TIMEOUT: 'PROCESS_TIMEOUT'
};