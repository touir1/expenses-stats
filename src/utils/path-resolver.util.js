const path = require('path');

// Get base directory (workspace root)
function getProjectRoot() {
  return path.join(__dirname, '..', '..');
}

// Resolve a path to absolute, with optional default
function resolvePath(inputPath, defaultPath = null, baseDir = null) {
  if (!baseDir) baseDir = getProjectRoot();
  
  const target = inputPath || defaultPath;
  if (!target) return null;
  
  if (path.isAbsolute(target)) {
    return target;
  }
  return path.join(baseDir, target);
}

// Build a path within the project structure
function buildProjectPath(...segments) {
  return path.join(getProjectRoot(), ...segments);
}

// Resolve a data file path with default
function resolveDataPath(relativePath, defaultSegments = []) {
  const baseDir = getProjectRoot();
  const defaultPath = defaultSegments.length ? path.join(baseDir, ...defaultSegments) : null;
  return resolvePath(relativePath, defaultPath, baseDir);
}

// Setup default paths for common files
function getDefaultPaths() {
  const root = getProjectRoot();
  return {
    parsedFile: path.join(root, 'data', 'processed', 'depenses.csv'),
    inputFile: path.join(root, 'data', 'processed', 'depenses-labeled.csv'),
    rawFile: path.join(root, 'data', 'raw', 'depenses.txt'),
    categoriesFile: path.join(root, 'config', 'categories.config.json'),
    forcedCategoriesFile: path.join(root, 'config', 'forced-categories.config.json'),
    conversionRatesFile: path.join(root, 'data', 'processed', 'conversion-rates.csv'),
    databaseFile: path.join(root, 'data', 'database', 'depenses.db'),
    outputDir: path.join(root, 'output'),
    configDir: path.join(root, 'config'),
    dataDir: path.join(root, 'data'),
  };
}

// Ensure directory exists
function ensureDir(dirPath) {
  const fs = require('fs');
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

module.exports = {
  getProjectRoot,
  resolvePath,
  buildProjectPath,
  resolveDataPath,
  getDefaultPaths,
  ensureDir
};
