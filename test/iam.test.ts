import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { ensureProjectRoles, modifyProjectIamPolicy, removeProjectRole } from '../src/iam.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

function mockCrm(initial: { bindings: Array<{ role: string; members: string[] }>; etag: string }) {
  const state = { policy: structuredClone(initial) };
  const getIamPolicy = mock.fn(async () => ({ data: structuredClone(state.policy) }));
  const setIamPolicy = mock.fn(async (req: { requestBody: { policy: typeof initial } }) => {
    state.policy = structuredClone(req.requestBody.policy);
    return { data: state.policy };
  });
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { getIamPolicy, setIamPolicy } }) as never);
  return { state, getIamPolicy, setIamPolicy };
}

test('ensureProjectRoles adds missing roles and preserves existing bindings + etag', async () => {
  const { state, setIamPolicy } = mockCrm({
    bindings: [{ role: 'roles/owner', members: ['user:me@example.com'] }],
    etag: 'abc',
  });
  const added = await ensureProjectRoles({} as never, 'p1', 'serviceAccount:sa@p1.iam.gserviceaccount.com', [
    'roles/aiplatform.user',
  ]);
  assert.deepEqual(added, ['roles/aiplatform.user']);
  assert.equal(setIamPolicy.mock.callCount(), 1);
  const sent = (setIamPolicy.mock.calls[0].arguments[0] as { requestBody: { policy: { etag: string; bindings: unknown[] } } }).requestBody.policy;
  assert.equal(sent.etag, 'abc');
  assert.equal(state.policy.bindings.length, 2, 'owner binding must survive');
  assert.ok(state.policy.bindings.some((b) => b.role === 'roles/owner' && b.members.includes('user:me@example.com')));
});

test('ensureProjectRoles is idempotent: no write when every role is already bound', async () => {
  const { setIamPolicy } = mockCrm({
    bindings: [{ role: 'roles/aiplatform.user', members: ['serviceAccount:sa@p1.iam.gserviceaccount.com'] }],
    etag: 'abc',
  });
  const added = await ensureProjectRoles({} as never, 'p1', 'serviceAccount:sa@p1.iam.gserviceaccount.com', [
    'roles/aiplatform.user',
  ]);
  assert.deepEqual(added, []);
  assert.equal(setIamPolicy.mock.callCount(), 0);
});

test('removeProjectRole drops the member and prunes an emptied binding', async () => {
  const { state } = mockCrm({
    bindings: [
      { role: 'roles/editor', members: ['serviceAccount:123-compute@developer.gserviceaccount.com'] },
      { role: 'roles/owner', members: ['user:me@example.com'] },
    ],
    etag: 'e1',
  });
  const changed = await removeProjectRole({} as never, 'p1', 'serviceAccount:123-compute@developer.gserviceaccount.com', 'roles/editor');
  assert.equal(changed, true);
  assert.deepEqual(state.policy.bindings, [{ role: 'roles/owner', members: ['user:me@example.com'] }]);
  const again = await removeProjectRole({} as never, 'p1', 'serviceAccount:123-compute@developer.gserviceaccount.com', 'roles/editor');
  assert.equal(again, false);
});

test('modifyProjectIamPolicy retries on an etag conflict and re-reads before the retry', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const getIamPolicy = mock.fn(async () => ({ data: { bindings: [], etag: `e${++calls}` } }));
  const setIamPolicy = mock.fn(async () => {
    if (setIamPolicy.mock.callCount() === 0) throw Object.assign(new Error('ABORTED: concurrent policy changes'), { code: 409 });
    return { data: { bindings: [{ role: 'r', members: ['m'] }], etag: 'final' } };
  });
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { getIamPolicy, setIamPolicy } }) as never);
  const p = modifyProjectIamPolicy({} as never, 'p1', (pol) => ({ ...pol, bindings: [{ role: 'r', members: ['m'] }] }));
  for (let i = 0; i < 10; i++) { mock.timers.runAll(); await Promise.resolve(); }
  const res = await p;
  assert.equal(res.changed, true);
  assert.equal(getIamPolicy.mock.callCount(), 2);
  assert.equal(setIamPolicy.mock.callCount(), 2);
});
