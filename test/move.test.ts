import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { moveProject, parseDestination } from '../src/move.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

async function drain<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
  tracked.catch(() => {});
  for (let i = 0; i < 200 && !settled; i++) {
    mock.timers.runAll();
    await new Promise((r) => setImmediate(r));
  }
  return tracked;
}

function mockCrm(opts: { parent?: string; canMove?: boolean; opDoneAfter?: number }) {
  const granted = async () => ({ data: { permissions: opts.canMove === false ? [] : ['resourcemanager.projects.move'] } });
  const move = mock.fn(async () => ({ data: { name: 'operations/mv1', done: false } }));
  let polls = 0;
  const opGet = mock.fn(async () => ({ data: { done: ++polls >= (opts.opDoneAfter ?? 1) } }));
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { get: async () => ({ data: { parent: opts.parent } }), testIamPermissions: granted, move },
    folders: { testIamPermissions: granted },
    organizations: { testIamPermissions: granted },
    operations: { get: opGet },
  }) as never);
  return { move, opGet };
}

test('parseDestination accepts org/folder resource names and rejects anything else', () => {
  assert.equal(parseDestination('organizations/123456789'), 'organizations/123456789');
  assert.equal(parseDestination('folders/987654321'), 'folders/987654321');
  assert.throws(() => parseDestination('123456789'), /must look like/);
  assert.throws(() => parseDestination('projects/abc'), /must look like/);
});

test('move: dry-run reports the plan and never calls projects.move', async () => {
  const { move } = mockCrm({});
  const res = await moveProject({ projectId: 'seed-unit-mv', destination: 'folders/987654321', auth: {} as never });
  assert.equal(res.dryRun, true);
  assert.equal(res.from, undefined);
  assert.equal(res.to, 'folders/987654321');
  assert.deepEqual(res.permissions, { onProject: true, onDestination: true });
  assert.equal(res.warnings.length, 0);
  assert.equal(move.mock.callCount(), 0);
});

test('move: dry-run warns when the caller lacks the move permission', async () => {
  mockCrm({ canMove: false });
  const res = await moveProject({ projectId: 'seed-unit-mv', destination: 'organizations/123456789', auth: {} as never });
  assert.deepEqual(res.permissions, { onProject: false, onDestination: false });
  assert.equal(res.warnings.length, 2);
  assert.match(res.warnings[0], /projectMover/);
});

test('move: already under the destination is a no-op, even with apply', async () => {
  const { move } = mockCrm({ parent: 'folders/987654321' });
  const res = await moveProject({ projectId: 'seed-unit-mv', destination: 'folders/987654321', apply: true, auth: {} as never });
  assert.equal(res.alreadyThere, true);
  assert.equal(res.moved, false);
  assert.equal(move.mock.callCount(), 0);
});

test('move: apply moves the project and waits for the operation', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { move, opGet } = mockCrm({ opDoneAfter: 2 });
  const res = await drain(
    moveProject({ projectId: 'seed-unit-mv', destination: 'organizations/123456789', apply: true, auth: {} as never }),
  );
  assert.equal(res.moved, true);
  assert.equal(move.mock.callCount(), 1);
  const [args] = move.mock.calls[0].arguments as unknown as [{ name: string; requestBody: { destinationParent: string } }];
  assert.equal(args.name, 'projects/seed-unit-mv');
  assert.equal(args.requestBody.destinationParent, 'organizations/123456789');
  assert.equal(opGet.mock.callCount(), 2, 'polled until the operation reported done');
});
