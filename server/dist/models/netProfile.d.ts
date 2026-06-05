import { Document, Schema, Connection, Model } from 'mongoose';

export interface NetProfile extends Document {
    title: string;
    frequency?: string;
    mode:
        | 'LSB'
        | 'USB'
        | 'AM'
        | 'CW'
        | 'FM'
        | 'RTTY'
        | 'FSQ'
        | 'PSK-31'
        | 'FreeDV'
        | 'Reflector'
        | 'Olivia'
        | 'Hell'
        | 'JS8Call'
        | 'CUSTOM';
    modeDetails?: string;
    notes?: string;
    owners: Schema.Types.ObjectId[];
    followers?: Schema.Types.ObjectId[];
    liveNet?: Schema.Types.ObjectId;
    autoIn: boolean;
    permanent: boolean;
    restrictedSigReports: boolean;
    invisible: boolean;
    createdAt?: Date;
    updatedAt?: Date;
}

export const netProfileSchema: Schema<NetProfile>;

export function getNetProfile(db?: Connection): Model<NetProfile>;
