// Jest configuration for Ham.Live OSS
module.exports = {
  projects: [
    {
      displayName: 'server',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/server/**/*.test.js'],
      testTimeout: 30000
    },
    {
      displayName: 'client',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/client/**/*.test.ts'],
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', moduleResolution: 'node' } }]
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
