// Parse command-line arguments and show help
// Usage:
//   const { args } = parseArgs(process.argv, [
//     { flag: '--input-file', param: true, default: 'path/to/file.csv' },
//     { flag: '--output', param: true, default: 'output' },
//     { flag: '--verbose', param: false },
//   ]);

function parseArgs(argv, optionDefs = []) {
  const args = argv.slice(2);
  const result = {};
  const flags = new Set();

  // Initialize defaults
  optionDefs.forEach(def => {
    if (def.default !== undefined) {
      result[def.flag.replace(/^--/, '')] = def.default;
    }
    flags.add(def.flag);
  });

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-h' || args[i] === '--help') {
      return { showHelp: true, args: result };
    }

    const def = optionDefs.find(d => d.flag === args[i]);
    if (def) {
      if (def.param && args[i + 1]) {
        result[def.flag.replace(/^--/, '')] = args[i + 1];
        i++;
      } else if (!def.param) {
        result[def.flag.replace(/^--/, '')] = true;
      }
    }
  }

  return { showHelp: false, args: result };
}

// Get value from parsed args with proper key format
function getArg(args, flagName) {
  const key = flagName.replace(/^--/, '');
  return args[key];
}

module.exports = {
  parseArgs,
  getArg
};
