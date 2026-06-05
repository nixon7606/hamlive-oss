const os = require('os');
const NetAdminCmd = require('../netAdminCmd');
const { logger } = require('../logger');

class SysCmd extends NetAdminCmd {
    constructor({ db, cs }) {
        super({
            label: 'system',
            commandProperties: {
                cmd: 'sys',
                alias: [],
                verboseUsage: '(sys) report system utilization statistics',
                compactUsage: 'sys',
                advanced: true,
                hidden: true,
                level: 1,
                mustBeCheckedIn: true,
                minArgs: 0,
                maxArgs: 0,
                deps: []
            },
            db,
            cs
        });
    }
    async run({ req, res, cmdLine }) {
        await super.run({ req, res, cmdLine });

        const hostname = process.env['DYNO'] || process.env['HOSTNAME'] || 'system';
        const load5 = os.loadavg()[1].toFixed(2);
        const cpuCount = os.cpus().length;

        // Free memory in MiB, formatted with commas
        const freeMemMiB = Math.round(os.freemem() / 1024 / 1024).toLocaleString();

        // Process uptime in human-readable format (hh:mm:ss)
        const uptimeSec = Math.floor(process.uptime());
        const hours = Math.floor(uptimeSec / 3600);
        const minutes = Math.floor((uptimeSec % 3600) / 60);
        const seconds = uptimeSec % 60;
        const uptimeStr = [hours, minutes, seconds].map(unit => String(unit).padStart(2, '0')).join(':');

        const report = `(${hostname}) process uptime ${uptimeStr}, load_5 ${load5} (cores: ${cpuCount}), freemem ${freeMemMiB}MiB`;

        logger.info(report);
        return report;
    }
}

module.exports = SysCmd;
