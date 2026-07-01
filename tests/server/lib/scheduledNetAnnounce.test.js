/* hamlive-oss — MIT License. See LICENSE. */
/**
 * Regression test: a scheduled net that auto-starts must send the
 * "net is going live" email to its followers. NetAnnounceStart's constructor
 * was replaced by a static async init(); the scheduledNetStarter caller must
 * use it (a `new NetAnnounceStart({netControl,...})` call throws inside the
 * try/catch and silently drops every scheduled-net announcement).
 */

jest.mock('../../../server/dist/models/emailSettings', () => ({
  loadEmailSettings: jest.fn(async () => null),
  saveEmailSettings: jest.fn()
}));
// Force templateService to use the on-disk .hbs files (no DB needed).
jest.mock('../../../server/dist/models/emailTemplate', () => ({
  getEmailTemplate: () => ({ findOne: async () => null })
}));
jest.mock('../../../server/dist/lib/configLib', () => ({
  conf: {
    base_url: 'http://localhost:3000',
    app_name: 'Ham.Live',
    email_from: 'Ham.Live <no-reply@example.com>',
    magic_link_secret: 'test-secret'
  }
}));
// Stub only the functions userNotification imports; avoids heavy serverUtils deps.
jest.mock('../../../server/dist/lib/serverUtils', () => ({
  fetchChatLog: jest.fn(async () => null),
  getFlexOptionsByUser: jest.fn(async () => ({ email: true })),
  isCurrentlyLocked: jest.fn(() => false)
}));

const { NetAnnounceStart } = require('../../../server/dist/lib/userNotification');
const { startScheduledNet } = require('../../../server/dist/lib/backgroundTasks/scheduledNetStarter');

test('auto-started scheduled net emails its followers via NetAnnounceStart', async () => {
  const sendSpy = jest
    .spyOn(NetAnnounceStart.prototype, 'sendMailToUPIDs')
    .mockResolvedValue(undefined);

  const fresh = {
    _id: 'np1',
    title: 'Sunday Rag Chew',
    owners: ['owner1'],
    followers: ['f1', 'f2'],
    schedule: { notifyBeforeMinutes: 30, notifyBeforeEnabled: true },
    markModified: () => {},
    save: async () => {}
  };

  const deps = {
    NetProfile: { findById: async () => fresh },
    UserProfile: {
      findById: () => ({
        lean: async () => ({ callSign: 'K1ABC', displayName: 'Op', email: 'op@example.com' })
      })
    },
    StationInteraction: class {
      constructor() { this._id = 'si1'; }
      async save() {}
    },
    LiveNet: class {
      constructor(opts) { Object.assign(this, opts); this._id = 'ln1'; }
      async save() { return this; }
    },
    db: {},
    createChatChannel: async () => {}
  };

  await startScheduledNet({ _id: 'np1', title: 'Sunday Rag Chew' }, deps);

  expect(sendSpy).toHaveBeenCalledTimes(1);
  expect(sendSpy.mock.calls[0][0].upids).toEqual(['f1', 'f2']);

  sendSpy.mockRestore();
});
