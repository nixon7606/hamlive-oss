import type { Request, Response } from 'express';
import { logger } from '#@server/lib/logger.js';
// import { signRmlPayload } from './roomlio';
import { handleRequest } from './responseUtils';

export const sign = (req: Request, res: Response) => {
    handleRequest(
        res,
        () => {
            const service = Array.isArray(req.query['service']) ? req.query['service'][0] : req.query['service'];

            if (typeof service !== 'string') {
                throw new Error('Invalid service parameter');
            }

            logger.debug(`Service: ${service}`);
            return Promise.resolve({ message: { service } });
        },
        `SecureSign`
    ).catch((error: Error) => {
        logger.error(`Error in handleRequest: ${error.message}`);
        res.status(500).send({ error: 'Internal Server Error' });
    });
};
