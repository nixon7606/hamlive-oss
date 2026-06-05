/* hamlive-oss — MIT License. See LICENSE. */

const { model } = require('mongoose');

module.exports.modelMaker = ({ db, m, s }) => {
    if (typeof m === 'undefined' || typeof s === 'undefined') {
        throw new Error('modelMaker() missing required params');
    } else {
        return db ? db.model(m, s) : model(m, s);
    }
};
