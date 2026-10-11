import { mock } from 'node:test';

/**
 * Advance mocked timers and yield macrotasks until `promise` settles, capped at
 * `maxMs` of real time. A fixed iteration count is not enough: code under test
 * can do real I/O (fs) between timers, and on a loaded CI runner that outlasts
 * any fixed number of turns, leaving the test awaiting a timer nobody fires.
 */
export async function drainUntilSettled(promise: Promise<unknown>, maxMs = 10_000): Promise<void> {
  let settled = false;
  promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  // performance.now(), not Date.now(): tests may mock Date, and the cap must be real time.
  const start = performance.now();
  while (!settled && performance.now() - start < maxMs) {
    mock.timers.runAll();
    await new Promise((r) => setImmediate(r));
  }
}
