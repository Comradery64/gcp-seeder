import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { PRESET_ROLES, validateRoles, grantServiceAccountRoles } from '../src/roles.js';

afterEach(() => mock.restoreAll());

const SA = 'seeder@p1.iam.gserviceaccount.com';

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

test('PRESET_ROLES: ai gets aiplatform.user, DWD presets get none, all pass validation', () => {
  assert.deepEqual(PRESET_ROLES.ai, ['roles/aiplatform.user']);
  for (const p of ['gmail', 'workspace', 'directory-sync']) assert.deepEqual(PRESET_ROLES[p], []);
  for (const rs of Object.values(PRESET_ROLES)) assert.deepEqual(validateRoles(rs), rs);
});

test('validateRoles accepts predefined and custom roles', () => {
  const rs = ['roles/aiplatform.user', 'projects/my-proj/roles/custom_1', 'organizations/123/roles/org.role'];
  assert.deepEqual(validateRoles(rs), rs);
});

test('validateRoles rejects basic roles by default and allows them with allowBasic', () => {
  for (const r of ['roles/owner', 'roles/editor', 'roles/viewer']) {
    assert.throws(() => validateRoles([r]), (err: Error) => err.message.includes(`"${r}"`));
    assert.deepEqual(validateRoles([r], { allowBasic: true }), [r]);
  }
});

test('validateRoles dedupes preserving order', () => {
  assert.deepEqual(validateRoles(['roles/a.b', 'roles/c', 'roles/a.b']), ['roles/a.b', 'roles/c']);
});

test('validateRoles error lists every invalid entry', () => {
  assert.throws(
    () => validateRoles(['aiplatform.user', 'roles/ok', 'roles/owner', 'folders/1/roles/x', 'roles/bad-dash']),
    (err: Error) =>
      ['"aiplatform.user"', '"roles/owner"', '"folders/1/roles/x"', '"roles/bad-dash"'].every((s) => err.message.includes(s)) &&
      !err.message.includes('"roles/ok"'),
  );
});

test('grantServiceAccountRoles sends exact serviceAccount member, preserves bindings, logs added', async () => {
  const { state, setIamPolicy } = mockCrm({
    bindings: [
      { role: 'roles/owner', members: ['user:me@example.com'] },
      { role: 'roles/logging.logWriter', members: ['user:other@example.com'] },
    ],
    etag: 'e1',
  });
  const lines: string[] = [];
  const added = await grantServiceAccountRoles({} as never, 'p1', SA, ['roles/aiplatform.user', 'roles/logging.logWriter'], (m) => lines.push(m));
  assert.deepEqual(added, ['roles/aiplatform.user', 'roles/logging.logWriter']);
  assert.equal(setIamPolicy.mock.callCount(), 1);
  const sent = setIamPolicy.mock.calls[0].arguments[0] as unknown as {
    resource: string;
    requestBody: { policy: { etag: string; bindings: Array<{ role: string; members: string[] }> } };
  };
  assert.equal(sent.resource, 'projects/p1');
  assert.equal(sent.requestBody.policy.etag, 'e1');
  assert.deepEqual(sent.requestBody.policy.bindings, [
    { role: 'roles/owner', members: ['user:me@example.com'] },
    { role: 'roles/logging.logWriter', members: ['user:other@example.com', `serviceAccount:${SA}`] },
    { role: 'roles/aiplatform.user', members: [`serviceAccount:${SA}`] },
  ]);
  assert.equal(state.policy.bindings.length, 3);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('roles/aiplatform.user'));
});

test('grantServiceAccountRoles is idempotent: second call writes nothing', async () => {
  const { setIamPolicy } = mockCrm({ bindings: [], etag: 'e1' });
  await grantServiceAccountRoles({} as never, 'p1', SA, ['roles/aiplatform.user']);
  assert.equal(setIamPolicy.mock.callCount(), 1);
  const lines: string[] = [];
  const again = await grantServiceAccountRoles({} as never, 'p1', SA, ['roles/aiplatform.user'], (m) => lines.push(m));
  assert.deepEqual(again, []);
  assert.equal(setIamPolicy.mock.callCount(), 1);
  assert.deepEqual(lines, []);
});

test('grantServiceAccountRoles with no roles makes no API calls', async () => {
  const { getIamPolicy } = mockCrm({ bindings: [], etag: 'e1' });
  assert.deepEqual(await grantServiceAccountRoles({} as never, 'p1', SA, []), []);
  assert.equal(getIamPolicy.mock.callCount(), 0);
});

test('grantServiceAccountRoles maps an invalid-role 400 to an error naming the role', async () => {
  const getIamPolicy = mock.fn(async () => ({ data: { bindings: [], etag: 'e1' } }));
  const setIamPolicy = mock.fn(async () => {
    throw Object.assign(new Error('Role roles/aiplatform.usr is not supported for this resource.'), { code: 400 });
  });
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { getIamPolicy, setIamPolicy } }) as never);
  await assert.rejects(
    grantServiceAccountRoles({} as never, 'p1', SA, ['roles/storage.objectViewer', 'roles/aiplatform.usr']),
    (err: Error) => err.message.startsWith('IAM role "roles/aiplatform.usr" was rejected'),
  );
});

test('grantServiceAccountRoles rethrows unrelated errors unchanged', async () => {
  const boom = Object.assign(new Error('PERMISSION_DENIED'), { code: 403 });
  const getIamPolicy = mock.fn(async () => {
    throw boom;
  });
  mock.method(google, 'cloudresourcemanager', () => ({ projects: { getIamPolicy, setIamPolicy: mock.fn() } }) as never);
  await assert.rejects(grantServiceAccountRoles({} as never, 'p1', SA, ['roles/aiplatform.user']), (e) => e === boom);
});
