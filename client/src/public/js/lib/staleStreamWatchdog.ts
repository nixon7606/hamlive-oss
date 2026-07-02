/* hamlive-oss — MIT License. See LICENSE. */

'use strict';

/**
 * Detects a dead-but-open SSE stream. An EventSource that is silently
 * buffered by an extension, AV proxy, or middlebox emits no error event —
 * the browser believes it is connected while nothing flows. Callers beat()
 * on every piece of stream activity (open, message, named event); if no
 * beat arrives within thresholdMs, onStale fires ONCE and the watchdog
 * disarms (the recovery path re-arms it when a fresh stream attaches).
 *
 * setInterval/clearInterval only — no DOM — so this is unit-testable with
 * fake timers and shared by the store layer and the chat client.
 */
export class StaleStreamWatchdog {
    private lastBeat = 0;
    private timer: ReturnType<typeof setInterval> | null = null;

    public constructor(
        private readonly thresholdMs: number,
        private readonly onStale: () => void,
        private readonly checkEveryMs = 15_000
    ) {}

    /** Record stream activity. */
    public beat(): void {
        this.lastBeat = Date.now();
    }

    /** (Re)arm the watchdog. Counts as a beat so a fresh start is never instantly stale. */
    public start(): void {
        this.stop();
        this.beat();
        this.timer = setInterval(() => {
            if (Date.now() - this.lastBeat > this.thresholdMs) {
                this.stop();
                this.onStale();
            }
        }, this.checkEveryMs);
    }

    /** Disarm. Safe to call when not running. */
    public stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
