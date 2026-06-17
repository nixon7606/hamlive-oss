/**
 * Jest global setup for Ham.Live OSS server tests.
 *
 * Starts a single in-memory MongoDB (mongodb-memory-server) once, before any
 * worker is forked. Test files read process.env.MONGO_URI at module-load time,
 * so the URI must exist before the workers spawn — globalSetup runs in the main
 * jest process ahead of the fork, so the env var is inherited by every worker.
 *
 * The server instance is stashed on globalThis so globalTeardown (which runs in
 * the same process) can stop it.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

module.exports = async () => {
  const mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri();
  process.env.NODE_ENV = 'test';
  globalThis.__MONGO_SERVER__ = mongoServer;
};
