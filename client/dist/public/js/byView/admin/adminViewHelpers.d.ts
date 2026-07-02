export interface NetSchedule {
    dayOfWeek?: number;
    hour?: number;
    minute?: number;
    timezone?: string;
    notifyBeforeMinutes?: number;
    enabled?: boolean;
}
export declare function nextOccurrence(sched: NetSchedule, now?: Date): Date | null;
export declare function relTime(deltaMs: number): string;
export declare function describeSchedule(sched: NetSchedule): string;
export declare function isBouncedStatus(s: string | undefined): boolean;
export declare function bucketRecentRows(rows: Array<{
    status?: string;
}>): {
    total: number;
    delivered: number;
    bounced: number;
    deferred: number;
    other: number;
};
export declare function buildWeekHTML(nets: any[], now?: Date): string;
export declare function buildAgendaHTML(nets: any[], now?: Date): string;
//# sourceMappingURL=adminViewHelpers.d.ts.map