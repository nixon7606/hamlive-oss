// Jest configuration for Ham.Live OSS
module.exports = {
  projects: [
    {
      displayName: 'server',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/server/**/*.test.js'],
      testTimeout: 30000,
      globalSetup: '<rootDir>/tests/server/globalSetup.js',
      globalTeardown: '<rootDir>/tests/server/globalTeardown.js',
      // These deps shipped ESM-only majors that jest's CJS runtime can't parse;
      // map them to CJS shims for tests (see tests/shims/).
      moduleNameMapper: {
        '^mongoose-unique-validator$': '<rootDir>/tests/shims/mongooseUniqueValidator.cjs',
        '^ap-style-title-case$': '<rootDir>/tests/shims/apStyleTitleCase.cjs'
      }
    },
    {
      displayName: 'client',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/client/**/*.test.ts'],
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', moduleResolution: 'node', types: ['jest', 'node'] } }]
      }
    }
  ],
  collectCoverageFrom: [
    'server/dist/lib/localChat.js',
    'server/dist/models/chatMessage.js',
    'server/dist/models/chatBan.js',
    'server/dist/routes/chatRoutes.js',
    'server/dist/lib/sseChat.js',
    'client/src/public/js/lib/localChat.ts',
    'client/src/public/js/lib/chat.ts'
  ],
  coverageReporters: ['text', 'lcov', 'html']
};
