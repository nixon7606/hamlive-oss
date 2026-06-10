/**
 * Test setup for Ham.Live OSS server tests.
 * Uses mongodb-memory-server to create an isolated MongoDB instance.
 */

const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  process.env.MONGO_URI = uri;
  process.env.NODE_ENV = 'test';
});

afterAll(async () => {
  if (mongoServer) {
    await mongoServer.stop();
  }
});
