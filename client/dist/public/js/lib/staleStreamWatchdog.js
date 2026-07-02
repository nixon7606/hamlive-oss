'use strict';
export class StaleStreamWatchdog {
    thresholdMs;
    onStale;
    checkEveryMs;
    lastBeat = 0;
    timer = null;
    constructor(thresholdMs, onStale, checkEveryMs = 15_000) {
        this.thresholdMs = thresholdMs;
        this.onStale = onStale;
        this.checkEveryMs = checkEveryMs;
    }
    beat() {
        this.lastBeat = Date.now();
    }
    start() {
        this.stop();
        this.beat();
        this.timer = setInterval(() => {
            if (Date.now() - this.lastBeat > this.thresholdMs) {
                this.stop();
                this.onStale();
            }
        }, this.checkEveryMs);
    }
    stop() {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
//# sourceMappingURL=staleStreamWatchdog.js.map