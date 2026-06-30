const ts = require('../../../server/dist/lib/templateService');

test('renders the net-close default with sample data', async () => {
  // getDefault reads the .hbs file; render compiles with provided data (no DB).
  const out = await ts.renderTemplate('net-close', {
    subject: 'My Net - Net Close Report', title: 'My Net', url: 'https://x/y',
    startedAtString: 'Sat, Jun 21, 2026, 7:30 AM MDT', timezoneAbbr: 'MDT',
    formattedAttendees: [{ role: 'NCS', callSign: 'K1ABC', displayName: 'Al', checkInTime: '7:30 AM', highlight: true }]
  }, { useDefault: true });
  expect(out.subject).toBe('My Net - Net Close Report');
  expect(out.html).toContain('K1ABC');
  expect(out.html).toContain('My Net');
  expect(out.html).toContain('background-color:#faf3e2'); // highlight branch rendered
});

test('renders magic-link default with the link', async () => {
  const out = await ts.renderTemplate('magic-link', { link: 'https://x/login?token=abc' }, { useDefault: true });
  expect(out.html).toContain('https://x/login?token=abc');
});

test('TEMPLATE_META lists variables for each key', () => {
  expect(ts.TEMPLATE_KEYS).toEqual(['magic-link', 'net-announce', 'net-close']);
  expect(ts.TEMPLATE_META['net-close'].variables).toContain('formattedAttendees');
});
