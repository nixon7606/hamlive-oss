/**
 * A dead-but-open SSE stream produces no error event — the watchdog is the
 * only thing standing between that and a view frozen until re-login.
 */
import { StaleStreamWatchdog } from '../../../client/src/public/js/lib/staleStreamWatchdog';

jest.useFakeTimers();

test('fires onStale once when no beats arrive within the threshold', () => {
  const onStale = jest.fn();
  const wd = new StaleStreamWatchdog(90_000, onStale, 15_000);
  wd.start();
  jest.advanceTimersByTime(89_000);
  expect(onStale).not.toHaveBeenCalled();
  jest.advanceTimersByTime(20_000); // past threshold + a check tick
  expect(onStale).toHaveBeenCalledTimes(1);
  // disarmed after firing — no repeat
  jest.advanceTimersByTime(300_000);
  expect(onStale).toHaveBeenCalledTimes(1);
});

test('regular beats keep it silent indefinitely', () => {
  const onStale = jest.fn();
  const wd = new StaleStreamWatchdog(90_000, onStale, 15_000);
  wd.start();
  for (let i = 0; i < 40; i++) { jest.advanceTimersByTime(20_000); wd.beat(); }
  expect(onStale).not.toHaveBeenCalled();
  wd.stop();
});

test('stop() disarms; start() re-arms fresh', () => {
  const onStale = jest.fn();
  const wd = new StaleStreamWatchdog(90_000, onStale, 15_000);
  wd.start();
  wd.stop();
  jest.advanceTimersByTime(500_000);
  expect(onStale).not.toHaveBeenCalled();
  wd.start(); // re-arm; start() itself counts as a beat
  jest.advanceTimersByTime(105_000);
  expect(onStale).toHaveBeenCalledTimes(1);
});

test('start() while running restarts cleanly (no duplicate timers)', () => {
  const onStale = jest.fn();
  const wd = new StaleStreamWatchdog(90_000, onStale, 15_000);
  wd.start();
  jest.advanceTimersByTime(60_000);
  wd.start(); // restart mid-flight
  jest.advanceTimersByTime(75_000); // 75s since restart < 90s
  expect(onStale).not.toHaveBeenCalled();
  jest.advanceTimersByTime(30_000);
  expect(onStale).toHaveBeenCalledTimes(1);
});
