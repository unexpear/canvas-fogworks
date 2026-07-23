// jest.config.js
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node', // Run tests in Node environment for pure logic testing
    roots: ['<rootDir>/src'], // Look for tests in the src directory
};