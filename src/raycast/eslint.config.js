// @raycast/eslint-config 2.x ships a flat config array directly. Version 1 was
// an eslintrc config that had to be wrapped in FlatCompat; wrapping the 2.x
// export instead throws "Converting circular structure to JSON", because
// FlatCompat tries to serialize a flat config as though it were eslintrc.
const raycast = require('@raycast/eslint-config');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...raycast,
];
