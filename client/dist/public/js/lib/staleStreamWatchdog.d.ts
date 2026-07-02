export declare class StaleStreamWatchdog {
    private readonly thresholdMs;
    private readonly onStale;
    private readonly checkEveryMs;
    private lastBeat;
    private timer;
    constructor(thresholdMs: number, onStale: () => void, checkEveryMs?: number);
    beat(): void;
    start(): void;
    stop(): void;
}
//# sourceMappingURL=staleStreamWatchdog.d.ts.map