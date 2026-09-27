import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { listLiens, removeLiens } from '../src/liens.js';

afterEach(() => mock.restoreAll());

test('listLiens returns parsed liens, paginated', async () => {
  const list = mock.fn(async ({ pageToken }: { pageToken?: string }) => {
    if (!pageToken) {
      return {
        data: {
          liens: [
            { name: 'liens/one', origin: 'compute.googleapis.com', reason: 'Shared VPC', restrictions: ['resourcemanager.projects.delete'] },
          ],
          nextPageToken: 'p2',
        },
      };
    }
    return {
      data: {
        liens: [{ name: 'liens/two', restrictions: ['resourcemanager.projects.delete'] }],
      },
    };
  });
  mock.method(google, 'cloudresourcemanager', () => ({ liens: { list } }) as never);

  const liens = await listLiens({} as never, 'proj-x');

  assert.equal(list.mock.callCount(), 2);
  assert.deepEqual(
    liens.map((l) => l.name),
    ['liens/one', 'liens/two'],
  );
  assert.equal(liens[0]!.origin, 'compute.googleapis.com');
  assert.equal(liens[0]!.reason, 'Shared VPC');
});

test('listLiens tolerates a 403 (API off / no permission) by returning an empty list', async () => {
  const list = mock.fn(async () => {
    throw Object.assign(new Error('The caller does not have permission'), { code: 403 });
  });
  mock.method(google, 'cloudresourcemanager', () => ({ liens: { list } }) as never);

  const liens = await listLiens({} as never, 'proj-x');

  assert.deepEqual(liens, []);
});

test('removeLiens deletes every lien found and returns their names', async () => {
  const list = mock.fn(async () => ({
    data: { liens: [{ name: 'liens/one' }, { name: 'liens/two' }] },
  }));
  const del = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudresourcemanager', () => ({ liens: { list, delete: del } }) as never);

  const removed = await removeLiens({} as never, 'proj-x');

  assert.equal(del.mock.callCount(), 2);
  assert.deepEqual(removed, ['liens/one', 'liens/two']);
});

test('removeLiens is a no-op (returns []) when there are no liens', async () => {
  const list = mock.fn(async () => ({ data: { liens: [] } }));
  const del = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudresourcemanager', () => ({ liens: { list, delete: del } }) as never);

  const removed = await removeLiens({} as never, 'proj-x');

  assert.equal(del.mock.callCount(), 0);
  assert.deepEqual(removed, []);
});
