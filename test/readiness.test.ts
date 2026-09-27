import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import {
  isApiNotReadyError,
  waitForServicesEnabled,
  probeApisReady,
  withApiReadyRetry,
} from '../src/readiness.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

function notReadyError(): Error & { code: number } {
  return Object.assign(
    new Error(
      'Cloud Resource Manager API has not been used in project 123456789 before or it is ' +
        'disabled. Enable it by visiting the console then retry. If you enabled this API ' +
        'recently, wait a few minutes for the action to propagate to our systems and retry.',
    ),
    { code: 403 },
  );
}

test('isApiNotReadyError is true for the canonical "not been used / disabled" 403', () => {
  assert.equal(isApiNotReadyError(notReadyError()), true);
});

test('isApiNotReadyError is false for a plain permission 403', () => {
  const err = Object.assign(new Error('Permission denied on resource'), { code: 403 });
  assert.equal(isApiNotReadyError(err), false);
});

test('isApiNotReadyError is false for a 404', () => {
  const err = Object.assign(new Error('Resource not found'), { code: 404 });
  assert.equal(isApiNotReadyError(err), false);
});

test('waitForServicesEnabled returns once every API reports ENABLED', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let call = 0;
  const get = mock.fn(async () => {
    call += 1;
    // First pass: DISABLED. Second pass: ENABLED.
    return { data: { state: call <= 1 ? 'DISABLED' : 'ENABLED' } };
  });
  mock.method(google, 'serviceusage', () => ({ services: { get } }) as never);

  const promise = waitForServicesEnabled({} as never, 'p1', ['serviceusage.googleapis.com'], {
    log: () => {},
  });
  for (let i = 0; i < 20; i++) {
    mock.timers.runAll();
    await Promise.resolve();
  }
  await promise;
  assert.ok(get.mock.callCount() >= 2);
});

test('waitForServicesEnabled throws on timeout, naming the still-not-ENABLED APIs', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const get = mock.fn(async () => ({ data: { state: 'DISABLED' } }));
  mock.method(google, 'serviceusage', () => ({ services: { get } }) as never);

  const promise = waitForServicesEnabled({} as never, 'p1', ['serviceusage.googleapis.com'], {
    timeoutMs: 10_000,
    intervalMs: 5_000,
    log: () => {},
  });
  const assertion = assert.rejects(promise, /serviceusage\.googleapis\.com/);
  for (let i = 0; i < 20; i++) {
    mock.timers.runAll();
    await Promise.resolve();
  }
  await assertion;
});

test('probeApisReady marks unknown APIs as skipped', async () => {
  const results = await probeApisReady({} as never, 'p1', ['made-up-api.googleapis.com']);
  assert.deepEqual(results, [{ api: 'made-up-api.googleapis.com', status: 'skipped' }]);
});

test('probeApisReady is ready on a 200', async () => {
  const list = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { get: list } }) as never);

  const results = await probeApisReady({} as never, 'p1', ['cloudresourcemanager.googleapis.com']);
  assert.deepEqual(results, [{ api: 'cloudresourcemanager.googleapis.com', status: 'ready' }]);
  assert.equal(list.mock.callCount(), 1);
});

test('probeApisReady is ready on a non-readiness 403 (permission error)', async () => {
  const get = mock.fn(async () => {
    throw Object.assign(new Error('Permission denied on resource'), { code: 403 });
  });
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { get } }) as never);

  const results = await probeApisReady({} as never, 'p1', ['cloudresourcemanager.googleapis.com']);
  assert.deepEqual(results, [{ api: 'cloudresourcemanager.googleapis.com', status: 'ready' }]);
});

test('probeApisReady reports timeout when the readiness 403 persists', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const get = mock.fn(async () => {
    throw notReadyError();
  });
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { get } }) as never);

  const promise = probeApisReady({} as never, 'p1', ['cloudresourcemanager.googleapis.com'], {
    timeoutMs: 10_000,
    intervalMs: 5_000,
    log: () => {},
  });
  for (let i = 0; i < 20; i++) {
    mock.timers.runAll();
    await Promise.resolve();
  }
  const results = await promise;
  assert.deepEqual(results, [{ api: 'cloudresourcemanager.googleapis.com', status: 'timeout' }]);
});

test('withApiReadyRetry retries while not-ready, then succeeds', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const fn = mock.fn(async () => {
    attempts += 1;
    if (attempts < 3) throw notReadyError();
    return 'ok';
  });

  const promise = withApiReadyRetry(fn, { attempts: 5, intervalMs: 1_000, log: () => {} });
  for (let i = 0; i < 20; i++) {
    mock.timers.runAll();
    await Promise.resolve();
  }
  const result = await promise;
  assert.equal(result, 'ok');
  assert.equal(fn.mock.callCount(), 3);
});

test('withApiReadyRetry rethrows a non-readiness error immediately', async () => {
  const err = Object.assign(new Error('Permission denied on resource'), { code: 403 });
  const fn = mock.fn(async () => {
    throw err;
  });

  await assert.rejects(withApiReadyRetry(fn, { attempts: 5, intervalMs: 1_000 }), /Permission denied/);
  assert.equal(fn.mock.callCount(), 1);
});
