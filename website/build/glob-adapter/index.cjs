// Only vite-plugin-dynamic-import's build-time sync(patterns, { cwd }) API.
// No fast-glob/micromatch/braces implementation is vendored or renamed.
const { globSync } = require('tinyglobby');
exports.sync = function sync(patterns, options = {}) {
  for (const key of Object.keys(options)) {
    if (key !== 'cwd') throw new Error(`Unsupported build glob option: ${key}`);
  }
  return globSync(patterns, { cwd: options.cwd, onlyFiles: true, dot: false, followSymbolicLinks: true });
};
