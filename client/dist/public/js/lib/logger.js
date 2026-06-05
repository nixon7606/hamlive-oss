import { serverInfo } from '#@client/lib/serverInfo.js';
const loggerMethods = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console)
};
const logLevelStyles = {
    error: 'color: red;',
    warn: 'color: orange;',
    info: 'color: white;',
    debug: 'color: cyan;'
};
const formatArgs = (args) => {
    return args.map(arg => (typeof arg === 'object' ? arg : String(arg)));
};
const shouldLog = (level) => {
    return serverInfo && (serverInfo.logLevel === 'debug' || (serverInfo.logLevel === 'info' && level !== 'debug'));
};
const formatLogMessage = (args, filename, level) => {
    const styledFilename = `%c${filename}%c `;
    const filenameStyle = 'color: black; background-color: white;';
    const messageStyle = logLevelStyles[level];
    const otherArgs = args
        .map(arg => {
        if (arg instanceof Error) {
            return `${arg.name}: ${arg.message}\n${arg.stack}`;
        }
        return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg;
    })
        .join(' ');
    return [styledFilename + otherArgs, filenameStyle, messageStyle];
};
export function createLogger(filename) {
    return new Proxy(loggerMethods, {
        get: (target, level) => {
            if (level in target) {
                return (...args) => {
                    args = formatArgs(args);
                    if (args.length > 0 && shouldLog(level)) {
                        const logMessage = formatLogMessage(args, filename, level);
                        Reflect.apply(target[level], console, logMessage);
                    }
                };
            }
            else {
                return () => { };
            }
        }
    });
}
//# sourceMappingURL=logger.js.map