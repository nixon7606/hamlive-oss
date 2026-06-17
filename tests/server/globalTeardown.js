/**
 * Jest global teardown — stops the in-memory MongoDB started in globalSetup.
 * Runs in the same process as globalSetup, so it can read the stashed instance.
 */
module.exports = async () => {
  const mongoServer = globalThis.__MONGO_SERVER__;
  if (mongoServer) {
    await mongoServer.stop();
  }
};
