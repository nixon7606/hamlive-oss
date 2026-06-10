/* hamlive-oss — MIT License. See LICENSE. */

const { logger } = require('../lib/logger');
const { netOwnerCheck, addNetOwner, delNet } = require('../lib/sharedNetOps');
const NetProfile = require('../models/netProfile').getNetProfile(null);
const UserProfile = require('../models/userProfile').getUserProfile(null);
const titleCase = require('ap-style-title-case');
const { sanitizeNotes } = require('../lib/serverUtils');

const netProfileList = async (req, res) => {
    let result;

    try {
        netlist = await Promise.all(
            req.user.myNets.map(async npObj => {
                return NetProfile.findById(npObj);
            })
        );
    } catch (err) {
        res.status(500).json({
            endpointVersion: '1.0',
            errorMessage: err.message
        });
        logger.error(err.stack);
    }

    res.json({ ...{ endpointVersion: '1.0' }, netlist });
};

const netProfileDetails = async (req, res) => {
    try {
        const npresult = await NetProfile.findById(req.params.id);
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

    logger.debug(req.body);

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

            // Schedule guardrails
            if (req.body.schedule && req.body.schedule.enabled !== false) {
                const s = req.body.schedule;
                if (s.dayOfWeek !== undefined && (s.dayOfWeek < 0 || s.dayOfWeek > 6)) {
                    throw new Error('dayOfWeek must be 0 (Sunday) through 6 (Saturday)');
                }
                if (s.hour !== undefined && (s.hour < 0 || s.hour > 23)) {
                    throw new Error('hour must be 0-23');
                }
                if (s.minute !== undefined && (s.minute < 0 || s.minute > 59)) {
                    throw new Error('minute must be 0-59');
                }
                if (s.notifyBeforeMinutes !== undefined && (s.notifyBeforeMinutes < 5 || s.notifyBeforeMinutes > 1440)) {
                    throw new Error('notifyBeforeMinutes must be 5-1440');
                }

                // Enforce max 3 scheduled nets per user
                if (s.enabled !== false) {
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
                        schedule: req.body.schedule ? {
                            dayOfWeek: req.body.schedule.dayOfWeek,
                            hour: req.body.schedule.hour,
                            minute: req.body.schedule.minute,
                            timezone: req.body.schedule.timezone || 'America/Denver',
                            notifyBeforeMinutes: req.body.schedule.notifyBeforeMinutes || 15,
                            enabled: req.body.schedule.enabled !== false
                        } : undefined
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
    let netProfileDoc;

    try {
        if (({ npresult: netProfileDoc } = await netOwnerCheck({ req }))) {
            result = await addNetOwner({
                newOwnerEmail,
                netProfiles: netProfileDoc,
                flexOpts: res.locals.flexOpts
            });

            res.status(200).json({
                endpointVersion: '1.0',
                message: result
            });
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
    console.debug(req.body);

    const { title, frequency, mode, restrictedSigReports, autoIn, modeDetails, notes } = req.body;

    const netprofile = new NetProfile({
        title: typeof title === 'string' ? titleCase(title.trim()) : undefined,
        frequency: typeof frequency === 'string' ? frequency.trim() : undefined,
        mode: typeof mode === 'string' ? mode.trim() : undefined,
        restrictedSigReports: restrictedSigReports ? true : false,
        autoIn: autoIn ? true : false,
        modeDetails: typeof modeDetails === 'string' ? modeDetails.trim() : undefined,
        notes: sanitizeNotes(notes),
        owners: req.user._id
    });

    try {
        const isCustomOrReflectorMode = mode => ['CUSTOM', 'Reflector'].includes(mode);

        if (!frequency && !isCustomOrReflectorMode(mode)) {
            throw new Error('empty frequency only permitted for CUSTOM or Reflector modes');
        }

        if (isCustomOrReflectorMode(mode) && !modeDetails) {
            throw new Error('mode details required for CUSTOM or Reflector modes');
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
    netProfileAddNetOwner,
    netProfileList,
    netProfileDetails,
    netProfileCreatePost,
    netProfileDelete,
    netProfileUpdate
};
