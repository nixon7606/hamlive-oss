import { Document, Schema, Connection, Model } from 'mongoose';

export interface InitialReg extends Document {
    callSign: string;
    startOfGracePeriod: Date;
}

export const initialRegSchema: Schema<InitialReg>;

export function getInitialReg(db?: Connection): Model<InitialReg>;
