import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { hardenProjectDefaults } from '../src/harden.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

const SA = 'serviceAccount:123-compute@developer.gserviceaccount.com';
const DEFAULT_NET = 'https://www.googleapis.com/compute/v1/projects/p1/global/networks/default';
const OTHER_NET = 'https://www.googleapis.com/compute/v1/projects/p1/global/networks/prod';

/** Drive a promise to completion while fake timers are enabled. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const out = p.finally(() => { settled = true; });
  out.catch(() => {});
  for (let i = 0; i < 500 && !settled; i++) {
    mock.timers.runAll();
    await new Promise((r) => setImmediate(r));
  }
  return out;
}

function httpErr(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

function mockCompute(opts: {
  rules?: Array<{ name: string; network: string }>;
  networkDelete?: () => Promise<unknown>;
  listErrors?: Error[];
} = {}) {
  const events: string[] = [];
  const pending = new Map<string, number>(); // op name -> polls remaining before DONE
  let n = 0;
  const startOp = (label: string) => {
    const name = `op-${++n}`;
    pending.set(name, 1);
    events.push(`start:${label}:${name}`);
    return { data: { name, status: 'RUNNING' } };
  };
  const listErrors = [...(opts.listErrors ?? [])];
  const firewalls = {
    list: mock.fn(async () => {
      const e = listErrors.shift();
      if (e) throw e;
      return { data: { items: opts.rules ?? [] } };
    }),
    delete: mock.fn(async (req: { firewall: string }) => startOp(`fw:${req.firewall}`)),
  };
  const networks = {
    delete: mock.fn(async (req: { network: string }) =>
      opts.networkDelete ? opts.networkDelete() : startOp(`net:${req.network}`)),
  };
  const globalOperations = {
    get: mock.fn(async (req: { operation: string }) => {
      const left = pending.get(req.operation)!;
      if (left > 0) {
        pending.set(req.operation, left - 1);
        return { data: { name: req.operation, status: 'RUNNING' } };
      }
      events.push(`done:${req.operation}`);
      return { data: { name: req.operation, status: 'DONE' } };
    }),
  };
  mock.method(google, 'compute', () => ({ firewalls, networks, globalOperations }) as never);
  return { events, firewalls, networks, globalOperations };
}

function mockCrm(bindings: Array<{ role: string; members: string[] }>) {
  const state = { policy: { bindings: structuredClone(bindings), etag: 'e1' } };
  const getIamPolicy = mock.fn(async () => ({ data: structuredClone(state.policy) }));
  const setIamPolicy = mock.fn(async (req: { requestBody: { policy: typeof state.policy } }) => {
    state.policy = structuredClone(req.requestBody.policy);
    return { data: state.policy };
  });
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { getIamPolicy, setIamPolicy } }) as never);
  return { state, setIamPolicy };
}

/** Any touch of the IAM API (where serviceAccounts.delete/disable live) fails the test. */
function forbidIam() {
  const trap = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`google.iam must never be touched by harden (accessed ${String(prop)})`);
    },
  });
  return mock.method(google, 'iam', () => trap as never);
}

test('deletes only default-network rules, then the network, waiting on each op in order', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const iam = forbidIam();
  const c = mockCompute({
    rules: [
      { name: 'default-allow-ssh', network: DEFAULT_NET },
      { name: 'prod-allow-https', network: OTHER_NET },
      { name: 'default-allow-rdp', network: DEFAULT_NET },
    ],
  });
  mockCrm([{ role: 'roles/editor', members: [SA] }]);
  const res = await drive(hardenProjectDefaults({} as never, 'p1', '123'));
  assert.deepEqual(res.firewallRulesDeleted, ['default-allow-ssh', 'default-allow-rdp']);
  assert.equal(res.defaultNetworkDeleted, true);
  assert.deepEqual(c.events, [
    'start:fw:default-allow-ssh:op-1', 'done:op-1',
    'start:fw:default-allow-rdp:op-2', 'done:op-2',
    'start:net:default:op-3', 'done:op-3',
  ]);
  assert.ok(!c.firewalls.delete.mock.calls.some((call) => (call.arguments[0] as { firewall: string }).firewall === 'prod-allow-https'));
  assert.equal(iam.mock.callCount(), 0);
});

test('a 404 on the network is recorded as skipped, not thrown', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  forbidIam();
  mockCompute({ networkDelete: async () => { throw httpErr(404, 'The resource was not found'); } });
  mockCrm([]);
  const res = await drive(hardenProjectDefaults({} as never, 'p1', '123'));
  assert.equal(res.defaultNetworkDeleted, false);
  assert.ok(res.skipped.some((s) => s.startsWith('default network')));
});

test('a failed compute operation surfaces its error', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  forbidIam();
  const c = mockCompute();
  c.globalOperations.get.mock.mockImplementation(async () => ({ data: { name: 'op-1', status: 'DONE', error: { errors: [{ code: 'RESOURCE_IN_USE_BY_ANOTHER_RESOURCE' }] } } }) as never);
  mockCrm([]);
  await assert.rejects(drive(hardenProjectDefaults({} as never, 'p1', '123')), /RESOURCE_IN_USE/);
});

test('removes Editor from the compute SA only, keeping other members; second run is a no-op', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  forbidIam();
  mockCompute();
  const { setIamPolicy } = mockCrm([
    { role: 'roles/editor', members: [SA, 'user:me@example.com'] },
    { role: 'roles/owner', members: ['user:me@example.com'] },
  ]);
  const res = await drive(hardenProjectDefaults({} as never, 'p1', '123'));
  assert.equal(res.defaultComputeSaEditorRemoved, true);
  assert.equal(setIamPolicy.mock.callCount(), 1);
  const sent = JSON.stringify((setIamPolicy.mock.calls[0].arguments[0] as { requestBody: unknown }).requestBody);
  assert.ok(!sent.includes('123-compute@'), 'compute SA must be gone from the payload');
  assert.ok(sent.includes('user:me@example.com'));
  assert.ok(sent.includes('roles/owner'));

  const again = await drive(hardenProjectDefaults({} as never, 'p1', '123'));
  assert.equal(again.defaultComputeSaEditorRemoved, false);
  assert.equal(setIamPolicy.mock.callCount(), 1, 'second run must not write IAM');
});

test('option toggles skip the respective step', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  forbidIam();
  const c = mockCompute({ rules: [{ name: 'default-allow-ssh', network: DEFAULT_NET }] });
  const { setIamPolicy } = mockCrm([{ role: 'roles/editor', members: [SA] }]);

  const a = await drive(hardenProjectDefaults({} as never, 'p1', '123', { deleteDefaultNetwork: false }));
  assert.equal(c.firewalls.list.mock.callCount(), 0);
  assert.equal(c.networks.delete.mock.callCount(), 0);
  assert.equal(a.defaultComputeSaEditorRemoved, true);

  const { setIamPolicy: set2 } = mockCrm([{ role: 'roles/editor', members: [SA] }]);
  const b = await drive(hardenProjectDefaults({} as never, 'p1', '123', { demoteDefaultComputeSa: false }));
  assert.equal(b.defaultNetworkDeleted, true);
  assert.equal(b.defaultComputeSaEditorRemoved, false);
  assert.equal(set2.mock.callCount(), 0);
  assert.equal(setIamPolicy.mock.callCount(), 1);
});

test('retries the compute "API not ready" 403, then succeeds', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  forbidIam();
  const notReady = () => httpErr(403, 'Compute Engine API has not been used in project 123 before or it is disabled.');
  const c = mockCompute({ listErrors: [notReady(), notReady()] });
  mockCrm([]);
  const res = await drive(hardenProjectDefaults({} as never, 'p1', '123'));
  assert.equal(c.firewalls.list.mock.callCount(), 3);
  assert.equal(res.defaultNetworkDeleted, true);
});

test('a non-readiness 403 is thrown immediately', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  forbidIam();
  const c = mockCompute({ listErrors: [httpErr(403, "Required 'compute.firewalls.list' permission for 'projects/p1'")] });
  mockCrm([]);
  await assert.rejects(drive(hardenProjectDefaults({} as never, 'p1', '123')), /compute\.firewalls\.list/);
  assert.equal(c.firewalls.list.mock.callCount(), 1);
});
