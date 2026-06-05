import { Document, Schema, Connection, Model } from 'mongoose';

export interface FlexOptions extends Document {
    scope: string;
    option: {
        gracePeriodDays: number;
        ads: number;
        chat: boolean;
        analytics: boolean;
        email: boolean;
        maxNetsPerUser: number;
        maxOwnersPerNet: number;
        netDetailsTtlSec: number;
        netListTtlSec: number;
        globalRefreshRate: number;
        baseTtlMs: number;
        awayInMs: number;
        httpClientTimeout: number;
        requestRateFactor: number;
        qrzDataReqTimeoutMs: number;
        qrzSessionReqTimeoutMs: number;
        qrzReqQuota: number;
        maxFollowersPerNet: number;
        maxFollowingPerUser: number;
        sigReportTypeByMode: {
            LSB: string;
            USB: string;
            AM: string;
            FreeDV: string;
            CW: string;
            Reflector: string | null;
            FM: string | null;
        };
    };
    createdAt?: Date;
    updatedAt?: Date;
}

export interface FlexOptionsLocal extends Document {
    option: {
        chat?: boolean;
        email?: boolean;
        ads?: number;
    };
    createdAt?: Date;
    updatedAt?: Date;
}

export const flexOptionsGlobalSchema: Schema<FlexOptions>;
export const flexOptionsLocalSchema: Schema<FlexOptionsLocal>;

export function getFlexOption(db?: Connection): Model<FlexOptions>;
