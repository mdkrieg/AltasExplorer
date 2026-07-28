/**
 * Jest Configuration
 * 
 * This file configures Jest for testing the AtlasExplorer application.
 * Key settings:
 * - testEnvironment: 'node' for Node.js (not browser) testing
 * - testMatch: Pattern to find test files (__tests__ directories or .test.js files)
 * - collectCoverageFrom: Tells Jest to measure test coverage for src/ (excluding preload for now)
 *
 * Renderer modules under public/js are native ES modules. They are testable
 * because (a) the npm test scripts invoke Jest through
 * `node --experimental-vm-modules`, and (b) public/js/package.json declares
 * `"type": "module"` so Jest resolves those files as ESM. Tests reach them with a
 * dynamic import; see src/__tests__/viewTypes.test.js. Running bare `jest` skips
 * the flag and those suites will fail to parse — use `npm test`.
 */

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/preload.js', // Preload is Electron-specific, harder to test
  ],
  verbose: true, // Show detailed test output
};
