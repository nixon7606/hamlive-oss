/**
 * CJS test shim for mongoose-unique-validator (v6 is ESM-only and cannot be
 * parsed by jest's CommonJS runtime). The plugin only improves the error
 * message on duplicate keys — uniqueness itself is enforced by the MongoDB
 * unique indexes the schemas declare, which the in-memory test DB honors. So a
 * no-op plugin is behaviourally safe for the suite.
 */
function uniqueValidator(_schema, _options) {
  // no-op
}
uniqueValidator.defaults = {};
module.exports = uniqueValidator;
module.exports.default = uniqueValidator;
