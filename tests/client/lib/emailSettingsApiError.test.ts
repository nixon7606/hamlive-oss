/**
 * The admin email endpoints report failures via body.errorMessage
 * (handleRequest → sendError → prepareEndPointResponse). The UI must surface
 * that text — not a generic "request failed".
 */
import { apiErrorMessage } from '../../../client/src/public/js/byView/admin/emailSettings';

test('surfaces the server errorMessage', () => {
  expect(apiErrorMessage({ errorMessage: 'subject and html are required' }))
    .toBe('subject and html are required');
});

test('falls back to a generic message when no errorMessage present', () => {
  expect(apiErrorMessage({})).toBe('request failed');
  expect(apiErrorMessage(null)).toBe('request failed');
  expect(apiErrorMessage('nonsense')).toBe('request failed');
});
