/* hamlive-oss — MIT License. See LICENSE. */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { FlexOptions, LiveNetDetailsResponse } from '#@client/types/commonTypes.js';

export interface GenLiveNetDetailsParams {
    npid: string;
    flexOpts: FlexOptions;
    permitCachedResponse?: boolean; // default: false
    requestingCallSign?: string;
}

export function genLiveNetDetails(params: GenLiveNetDetailsPrams): Promise<LiveNetDetailsResponse>;
