/**
 * CJS test shim for ap-style-title-case (v2 is ESM-only and cannot be parsed by
 * jest's CommonJS runtime). No test asserts AP title-case rules, so a simple
 * word-capitalizer is sufficient to keep the controller code paths working.
 */
function apStyleTitleCase(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value
    .split(/\s+/)
    .map(word => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function capitalize(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

module.exports = { apStyleTitleCase, capitalize };
module.exports.default = apStyleTitleCase;
