/* hamlive-oss — MIT License. See LICENSE. */
/**
 * Integration tests for the Task-6 class conversions: proves that
 * NetAnnounceStart.init() and NetCloseReport.init() call renderTemplate,
 * inject the rendered HTML into body, and no longer use the SendGrid
 * templateId path.
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
// Stub only the two functions userNotification imports; avoids heavy serverUtils deps.
jest.mock('../../../server/dist/lib/serverUtils', () => ({
  fetchChatLog: jest.fn(async () => null),
  getFlexOptionsByUser: jest.fn(async () => ({ email: true })),
  isCurrentlyLocked: jest.fn(() => false)
}));

const { NetAnnounceStart, NetCloseReport } = require('../../../server/dist/lib/userNotification');

// ── NetAnnounceStart ──────────────────────────────────────────────────────────

test('NetAnnounceStart.init() renders the net-announce template into body.html', async () => {
  const inst = await NetAnnounceStart.init({
    netControl: 'K1ABC',
    netProfileDoc: { title: 'Sunday Rag Chew' },
    liveNetDoc: { countdownTimer: 10, url: '/views/livenet/abc123' }
  });

  expect(inst.type).toBe('net-announce');
  expect(typeof inst.body.html).toBe('string');
  expect(inst.body.html).toContain('Sunday Rag Chew');
  expect(inst.body.html.length).toBeGreaterThan(100);
  expect(inst.body.subject).toMatch(/Sunday Rag Chew/);
  // No templateId — we are not using the SendGrid template path
  expect(inst.body.templateId).toBeUndefined();
});

test('NetAnnounceStart.init() humanTime=now for countdownTimer<=1', async () => {
  const inst = await NetAnnounceStart.init({
    netControl: 'W2DEF',
    netProfileDoc: { title: 'Quick Net' },
    liveNetDoc: { countdownTimer: 0, url: '/views/livenet/xyz' }
  });
  expect(inst.body.subject).toContain('now');
});

// ── NetCloseReport ────────────────────────────────────────────────────────────

const SAMPLE_ATTENDEES = [
  {
    callSign: 'K1ABC', role: 'netcontrol', displayName: 'Al', location: 'Denver CO',
    checkedInAt: new Date('2026-06-21T13:30:00Z'), rst: '59', highlight: false
  },
  {
    callSign: 'W2DEF', role: 'netuser', displayName: 'Bea', location: 'Boston MA',
    checkedInAt: new Date('2026-06-21T13:32:00Z'), rst: '57', highlight: true
  }
];

test('NetCloseReport.init() renders net-close template and drops the SendGrid templateId path', async () => {
  const inst = await NetCloseReport.init({
    netProfileDoc: {
      id: 'npid123', title: 'Sunday Rag Chew',
      schedule: { timezone: 'America/Denver' }
    },
    liveNetDoc: {
      url: '/views/livenet/abc', started: true,
      startedAt: new Date('2026-06-21T13:30:00Z')
    },
    attendees: SAMPLE_ATTENDEES
  });

  // Template rendered into body.html
  expect(typeof inst.body.html).toBe('string');
  expect(inst.body.html).toContain('K1ABC');
  expect(inst.body.html.length).toBeGreaterThan(200);

  // Subject set directly on body (not via dynamic_template_data)
  expect(inst.body.subject).toBe('Sunday Rag Chew - Net Close Report');

  // templateId MUST be gone — confirms SendGrid-template path is retired
  expect(inst.body.templateId).toBeUndefined();
  expect(inst.body.dynamic_template_data).toBeUndefined();

  // CSV + chat attachments are still present
  expect(Array.isArray(inst.body.attachments)).toBe(true);
  expect(inst.body.attachments).toHaveLength(2);

  expect(inst.type).toBe('net-close-report');
});
