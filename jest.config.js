/**
 * Jest Configuration
 * 
 * This file configures Jest for testing the BestExplorer application.
 * Key settings:
 * - testEnvironment: 'node' for Node.js (not browser) testing
 * - testMatch: Pattern to find test files (__tests__ directories or .test.js files)
 * - collectCoverageFrom: Tells Jest to measure test coverage for src/ (excluding preload for now)
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
