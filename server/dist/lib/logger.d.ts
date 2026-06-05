/* hamlive-oss — MIT License. See LICENSE. */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare module '#@server/lib/logger.js' {
    export interface Logger {
        error: (...args: any[]) => void;
        warn: (...args: any[]) => void;
        info: (...args: any[]) => void;
        debug: (...args: any[]) => void;
    }

    export interface HttpLogger {
        (req: { method: string; originalUrl: string }, res: { statusCode: number }, time: number): void;
    }

    export const logger: Logger;
    export const httpLogger: HttpLogger;
}
