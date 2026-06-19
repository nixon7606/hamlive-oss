/* hamlive-oss — MIT License. See LICENSE. */

const { logger } = require('../lib/logger');
const { netOwnerCheck, addNetOwner, delNet } = require('../lib/sharedNetOps');
const NetProfile = require('../models/netProfile').getNetProfile(null);
const UserProfile = require('../models/userProfile').getUserProfile(null);
const titleCase = require('ap-style-title-case');
const { sanitizeNotes } = require('../lib/serverUtils');

/**
 * Validate a raw schedule input and return the normalized schedule subdocument
 * (or undefined when no schedule given). Throws on out-of-range field values.
 * Used by both create and update so the rules stay in one place.
 */
function buildAndValidateSchedule(input) {
    if (!input) return undefined;
    const s = input;
    if (s.enabled !== false) {
        if (s.dayOfWeek !== undefined && (s.dayOfWeek < 0 || s.dayOfWeek > 6)) {
            throw new Error('dayOfWeek must be 0 (Sunday) through 6 (Saturday)');
        }
        if (s.hour !== undefined && (s.hour < 0 || s.hour > 23)) throw new Error('hour must be 0-23');
        if (s.minute !== undefined && (s.minute < 0 || s.minute > 59)) throw new Error('minute must be 0-59');
        if (s.notifyBeforeMinutes !== undefined && (s.notifyBeforeMinutes < 5 || s.notifyBeforeMinutes > 1440)) {
            throw new Error('notifyBeforeMinutes must be 5-1440');
        }
    }
    return {
        dayOfWeek: s.dayOfWeek,
        hour: s.hour,
        minute: s.minute,
        timezone: s.timezone || 'America/Denver',
        notifyBeforeMinutes: s.notifyBeforeMinutes || 15,
        enabled: s.enabled !== false
    };
}

const netProfileList = async (req, res) => {
    try {
        const fetched = await Promise.all(
            req.user.myNets.map(npObj => NetProfile.findById(npObj))
        );
        // Drop null entries: a myNets id dangles if its net profile was deleted —
        // findById returns null for it, which otherwise crashes the client's
        // render loop (reading null._id) and breaks the whole My Nets page.
        const netlist = fetched.filter(Boolean);
        res.json({ endpointVersion: '1.0', netlist });
    } catch (err) {
        res.status(500).json({ endpointVersion: '1.0', errorMessage: err.message });
        logger.error(err.stack);
    }
};

const netProfileDetails = async (req, res) => {
    try {
        const npresult = await NetProfile.findById(req.params.id);
        if (!npresult) {
            return res.status(404).json({ endpointVersion: '1.0', errorMessage: 'Net profile not found' });
        }
        return res.json({
            endpointVersion: '1.0',
            _id: npresult._id,
            title: npresult.title,
            frequency: npresult.frequency,
            mode: npresult.mode,
            restrictedSigReports: npresult?.restrictedSigReports ? true : false,
            autoIn: npresult?.autoIn ? true : false,
            modeDetails: npresult.modeDetails,
            notes: sanitizeNotes(npresult.notes),
            live: npresult.liveNet ? true : false,
            schedule: npresult.schedule || null
        });
    } catch (err) {
        res.status(500).json({
            endpointVersion: '1.0',
            errorMessage: err.message
        });
        logger.error(err.stack);
    }
};

const netProfileUpdate = async (req, res) => {
    const id = req.params.id;

    logger.debug('netProfileUpdate: editing ' + req.params.id);

    try {
        const { confirmed, npresult } = await netOwnerCheck({ req });

        if (confirmed) {
            logger.info('NETPROFILE_Controller: editing: ' + npresult.toObject().title);

            const isCustomOrReflector = req.body.mode === 'CUSTOM' || req.body.mode === 'Reflector';

            if (!req.body.frequency && !isCustomOrReflector) {
                throw new Error('empty frequency only permitted for CUSTOM or Digital Reflector modes');
            }

            if (isCustomOrReflector && !req.body.modeDetails) {
                throw new Error('mode details required for CUSTOM or Digital Reflector modes');
            }

            // Schedule guardrails (range validation via helper; async max-3 check kept here)
            const schedule = buildAndValidateSchedule(req.body.schedule); // throws on bad field ranges
            if (req.body.schedule && req.body.schedule.enabled !== false) {
                // Enforce max 3 scheduled nets per user
                const NetProfile = require('../models/netProfile').getNetProfile(null);
                const existingScheduled = await NetProfile.countDocuments({
                    _id: { $ne: id },
                    owners: req.user._id,
                    'schedule.enabled': true
                });
                if (existingScheduled >= 3) {
                    throw new Error('Maximum 3 scheduled nets allowed. Disable an existing schedule first.');
                }
            }

            let updateResult;

            if (
                (updateResult = await npresult.updateOne(
                    {
                        title: titleCase(req.body.title.trim()),
                        frequency: req.body.frequency && req.body.frequency.trim(),
                        mode: req.body.mode && req.body.mode.trim(),
                        restrictedSigReports: req.body.restrictedSigReports ? true : false,
                        autoIn: req.body.autoIn ? true : false,
                        modeDetails: req.body.modeDetails && req.body.modeDetails.trim(),
                        notes: sanitizeNotes(req.body.notes),
                        schedule
                    },
                    { runValidators: true }
                ))
            ) {
                res.json({ ...updateResult, ...{ endpointVersion: '1.0' } });
            } else {
                throw new Error('netprofile find and update failed');
            }
        } else {
            throw new Error('user is not owner for this net');
        }
    } catch (err) {
        res.status(500).json({
            endpointVersion: '1.0',
            errorMessage: err.message,
            status: 500
        });
        logger.error(err.stack);
    }
};

const netProfileDelete = async (req, res) => {
    let result;

    try {
        result = await delNet({ upid: req.user.id, npid: req.params.id });

        res.status(200).json({
            endpointVersion: '1.0',
            message: result
        });
        logger.info('NETPROFILE_Controller: ' + result);
    } catch (err) {
        res.status(500).json({
            endpointVersion: '1.0',
            errorMessage: err.message
        });
        logger.error(err.stack);
    }
};

const netProfileAddNetOwner = async (req, res) => {
    const newOwnerEmail = req.body.email && req.body.email.trim();
    let result;

    try {
        const { confirmed, npresult: netProfileDoc } = await netOwnerCheck({ req });
        if (confirmed) {
            result = await addNetOwner({
                newOwnerEmail,
                netProfiles: netProfileDoc,
                flexOpts: res.locals.flexOpts
            });
            res.status(200).json({ endpointVersion: '1.0', message: result });
            logger.info('NETPROFILE_Controller: ' + result);
        } else {
            throw new Error('requestor must have net owner privileges');
        }
    } catch (err) {
        logger.error(err.stack);
        res.status(500).json({
            endpointVersion: '1.0',
            errorMessage: err.message
        });
    }
};

const netProfileCreatePost = async (req, res) => {
    const { title, frequency, mode, restrictedSigReports, autoIn, modeDetails, notes, schedule } = req.body;

    try {
        const isCustomOrReflectorMode = mode => ['CUSTOM', 'Reflector'].includes(mode);
        const normalizedSchedule = buildAndValidateSchedule(schedule);

        const netprofile = new NetProfile({
            title: typeof title === 'string' ? titleCase(title.trim()) : undefined,
            frequency: typeof frequency === 'string' ? frequency.trim() : undefined,
            mode: typeof mode === 'string' ? mode.trim() : undefined,
            restrictedSigReports: restrictedSigReports ? true : false,
            autoIn: autoIn ? true : false,
            modeDetails: typeof modeDetails === 'string' ? modeDetails.trim() : undefined,
            notes: sanitizeNotes(notes),
            owners: req.user._id,
            schedule: normalizedSchedule
        });

        if (!frequency && !isCustomOrReflectorMode(mode)) {
            throw new Error('empty frequency only permitted for CUSTOM or Reflector modes');
        }

        if (isCustomOrReflectorMode(mode) && !modeDetails) {
            throw new Error('mode details required for CUSTOM or Reflector modes');
        }

        if (schedule && schedule.enabled !== false) {
            const NetProfileM = require('../models/netProfile').getNetProfile(null);
            const scheduledCount = await NetProfileM.countDocuments({ owners: req.user._id, 'schedule.enabled': true });
            if (scheduledCount >= 3) {
                throw new Error('Maximum 3 scheduled nets allowed. Disable an existing schedule first.');
            }
        }

        if (req.user.myNets.length < res.locals.flexOpts['maxNetsPerUser']) {
            const npresult = await netprofile.save();
            res.json({ ...{ endpointVersion: '1.0' }, ...npresult.toObject() });
            logger.info('NETPROFILE_Controller: Net profile saved: ' + npresult.toObject().title);

            if (npresult) {
                logger.info('NETPROFILE_Controller: Add owner for new net');
                try {
                    const upresult = await UserProfile.findOneAndUpdate(
                        { _id: req.user._id },
                        {
                            $push: { myNets: npresult._id }
                        }
                    );

                    logger.info(
                        'NETPROFILE_Controller: User profile updated (+Net Owner): ' + upresult.toObject().callSign
                    );
                } catch (err) {
                    res.status(500).json({
                        endpointVersion: '1.0',
                        errorMessage: err.message
                    });
                    logger.error(err.stack);
                }
            }
        } else {
            throw new Error('at max nets per user');
        }
    } catch (err) {
        res.status(500).json({
            endpointVersion: '1.0',
            errorMessage: err.message,
            status: 500
        });
        logger.error(err.stack);
    }
};

module.exports = {
    buildAndValidateSchedule,
    netProfileAddNetOwner,
    netProfileList,
    netProfileDetails,
    netProfileCreatePost,
    netProfileDelete,
    netProfileUpdate
};
