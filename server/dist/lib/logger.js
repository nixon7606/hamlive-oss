/* hamlive-oss — MIT License. See LICENSE. */

const path = require('path');
const colorLogger = require('node-color-log');
const Logger = require('node-json-logger');

const formatArgs = args => {
    return args.map(arg => {
        if (Array.isArray(arg)) {
            console.table(arg);
            return '';
        } else if (typeof arg === 'object') {
            return JSON.stringify(arg, null, 2);
        } else {
            return arg;
        }
    });
};

const getFileName = () => {
    const error = new Error();
    const stack = error.stack.split('\n');
    const callSite = stack[3];
    const match = callSite.match(/\((.*):[0-9]+:[0-9]+\)/);
    if (match) {
        const filePath = match[1];
        return path.basename(filePath);
    }
    return '';
};

const getTimeStamp = () => {
    return `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`;
};

const logMethodFactory = (color, isBold = false, logFileName = true) => {
    return (...args) => {
        args = formatArgs(args);
        if (logFileName) {
            colorLogger.color('black').bgColor('white').log(getFileName());
        }
        const logger = colorLogger.color(color);
        if (isBold) logger.bold();
        logger.log(`${getTimeStamp()} `, ...args);
    };
};

let logger;

if (process.env.NODE_ENV === 'development') {
    logger = {
        error: logMethodFactory('red', true),
        warn: logMethodFactory('yellow', true),
        info: logMethodFactory('white'),
        debug: logMethodFactory('cyan')
    };
} else {
    logger = new Logger({ level: process.env.LOG_LEVEL });
}

const TIME_THRESHOLD = 1000;
const logLevels = {
    500: 'error',
    1000: 'warn',
    default: 'debug'
};

function httpLogger(req, res, time) {
    const truncatedTime = Number(time).toFixed(2);
    const message = `${req.method} ${req.originalUrl}\t${res.statusCode}\t${truncatedTime} ms`;

    const logLevel =
        res.statusCode >= 500 ? logLevels[500] : truncatedTime > TIME_THRESHOLD ? logLevels[1000] : logLevels.default;

    if (process.env.NODE_ENV === 'development') {
        logMethodFactory(
            logLevel === 'error' ? 'red' : logLevel === 'warn' ? 'yellow' : 'magenta',
            false,
            false
        )(message);
    } else {
        logger[logLevel](message);
    }
}

module.exports = {
    logger,
    httpLogger
};
