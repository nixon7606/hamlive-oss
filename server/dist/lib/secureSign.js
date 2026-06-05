"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sign = void 0;
const logger_js_1 = require("#@server/lib/logger.js");
const responseUtils_1 = require("./responseUtils");
const sign = (req, res) => {
    (0, responseUtils_1.handleRequest)(res, () => {
        const service = Array.isArray(req.query['service']) ? req.query['service'][0] : req.query['service'];
        if (typeof service !== 'string') {
            throw new Error('Invalid service parameter');
        }
        logger_js_1.logger.debug(`Service: ${service}`);
        return Promise.resolve({ message: { service } });
    }, `SecureSign`).catch((error) => {
        logger_js_1.logger.error(`Error in handleRequest: ${error.message}`);
        res.status(500).send({ error: 'Internal Server Error' });
    });
};
exports.sign = sign;
