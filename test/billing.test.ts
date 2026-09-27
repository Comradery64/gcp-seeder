import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { countLinkedProjects } from '../src/billing.js';
import {
  listBillingAccounts,
  resolveBillingAccount,
  linkBillingAccount,
  getLinkedBillingAccount,
  canLinkProjects,
} from '../src/billing.js';

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

test('listBillingAccounts paginates across pages', async () => {
  const list = mock.fn(async (req: { pageToken?: string }) => {
    if (!req.pageToken) {
      return {
        data: {
          billingAccounts: [{ name: 'billingAccounts/AAA-111', displayName: 'First', open: true }],
          nextPageToken: 'p2',
        },
      };
    }
    return {
      data: {
        billingAccounts: [{ name: 'billingAccounts/BBB-222', displayName: 'Second', open: false }],
      },
    };
  });
  mock.method(google, 'cloudbilling', () => ({ billingAccounts: { list } }) as never);

  const accounts = await listBillingAccounts({} as never);
  assert.equal(list.mock.callCount(), 2);
  assert.deepEqual(accounts, [
    { name: 'billingAccounts/AAA-111', displayName: 'First', open: true },
    { name: 'billingAccounts/BBB-222', displayName: 'Second', open: false },
  ]);
});

function mockList(accounts: Array<{ name: string; displayName: string; open: boolean }>) {
  mock.method(google, 'cloudbilling', () => ({
    billingAccounts: { list: async () => ({ data: { billingAccounts: accounts } }) },
  }) as never);
}

test('resolveBillingAccount accepts an explicit id without the prefix', async () => {
  mockList([{ name: 'billingAccounts/012345-ABCDEF-678901', displayName: 'Main', open: true }]);
  const { account, candidates } = await resolveBillingAccount({} as never, '012345-ABCDEF-678901');
  assert.equal(account, 'billingAccounts/012345-ABCDEF-678901');
  assert.deepEqual(candidates, []);
});

test('resolveBillingAccount accepts an explicit id with the prefix', async () => {
  mockList([{ name: 'billingAccounts/012345-ABCDEF-678901', displayName: 'Main', open: true }]);
  const { account } = await resolveBillingAccount({} as never, 'billingAccounts/012345-ABCDEF-678901');
  assert.equal(account, 'billingAccounts/012345-ABCDEF-678901');
});

test('resolveBillingAccount rejects an unknown requested id', async () => {
  mockList([{ name: 'billingAccounts/012345-ABCDEF-678901', displayName: 'Main', open: true }]);
  await assert.rejects(
    resolveBillingAccount({} as never, '999999-ZZZZZZ-000000'),
    /was not found among the accounts you can access/,
  );
});

test('resolveBillingAccount rejects a closed requested id', async () => {
  mockList([{ name: 'billingAccounts/012345-ABCDEF-678901', displayName: 'Main', open: false }]);
  await assert.rejects(
    resolveBillingAccount({} as never, '012345-ABCDEF-678901'),
    /is closed and cannot be linked/,
  );
});

test('resolveBillingAccount auto-picks the single open account', async () => {
  mockList([
    { name: 'billingAccounts/AAA-111', displayName: 'Open', open: true },
    { name: 'billingAccounts/BBB-222', displayName: 'Closed', open: false },
  ]);
  const { account, candidates } = await resolveBillingAccount({} as never);
  assert.equal(account, 'billingAccounts/AAA-111');
  assert.deepEqual(candidates, []);
});

test('resolveBillingAccount returns no account and no candidates when none are open', async () => {
  mockList([{ name: 'billingAccounts/BBB-222', displayName: 'Closed', open: false }]);
  const { account, candidates } = await resolveBillingAccount({} as never);
  assert.equal(account, undefined);
  assert.deepEqual(candidates, []);
});

test('resolveBillingAccount returns candidates when several accounts are open', async () => {
  mockList([
    { name: 'billingAccounts/AAA-111', displayName: 'One', open: true },
    { name: 'billingAccounts/BBB-222', displayName: 'Two', open: true },
  ]);
  const { account, candidates } = await resolveBillingAccount({} as never);
  assert.equal(account, undefined);
  assert.equal(candidates.length, 2);
});

test('linkBillingAccount happy path calls updateBillingInfo', async () => {
  const getBillingInfo = mock.fn(async () => ({ data: { billingEnabled: false } }));
  const updateBillingInfo = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudbilling', () => ({
    projects: { getBillingInfo, updateBillingInfo },
  }) as never);

  const logs: string[] = [];
  await linkBillingAccount({} as never, 'proj-1', '012345-ABCDEF-678901', (m) => logs.push(m));
  assert.equal(updateBillingInfo.mock.callCount(), 1);
  const req = updateBillingInfo.mock.calls[0].arguments[0] as { name: string; requestBody: { billingAccountName: string } };
  assert.equal(req.name, 'projects/proj-1');
  assert.equal(req.requestBody.billingAccountName, 'billingAccounts/012345-ABCDEF-678901');
  assert.ok(logs.some((l) => /Linked/.test(l)));
});

test('linkBillingAccount is idempotent when already linked to the target account', async () => {
  const getBillingInfo = mock.fn(async () => ({
    data: { billingEnabled: true, billingAccountName: 'billingAccounts/012345-ABCDEF-678901' },
  }));
  const updateBillingInfo = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudbilling', () => ({
    projects: { getBillingInfo, updateBillingInfo },
  }) as never);

  const logs: string[] = [];
  await linkBillingAccount({} as never, 'proj-1', '012345-ABCDEF-678901', (m) => logs.push(m));
  assert.equal(updateBillingInfo.mock.callCount(), 0);
  assert.ok(logs.some((l) => /already linked/.test(l)));
});

test('linkBillingAccount maps a 403 to the billing.user explanation', async () => {
  mock.method(google, 'cloudbilling', () => ({
    projects: {
      getBillingInfo: async () => ({ data: { billingEnabled: false } }),
      updateBillingInfo: async () => {
        throw Object.assign(new Error('forbidden'), { code: 403 });
      },
    },
  }) as never);

  await assert.rejects(
    linkBillingAccount({} as never, 'proj-1', '012345-ABCDEF-678901'),
    /you need roles\/billing\.user ON THE BILLING ACCOUNT itself/,
  );
});

test('linkBillingAccount maps a precondition failure to the quota explanation', async () => {
  mock.method(google, 'cloudbilling', () => ({
    projects: {
      getBillingInfo: async () => ({ data: { billingEnabled: false } }),
      updateBillingInfo: async () => {
        throw Object.assign(new Error('Precondition check failed.'), { code: 400 });
      },
    },
  }) as never);

  await assert.rejects(
    linkBillingAccount({} as never, 'proj-1', '012345-ABCDEF-678901'),
    /projects-per-billing-account quota/,
  );
});

test('getLinkedBillingAccount returns undefined when unlinked', async () => {
  mock.method(google, 'cloudbilling', () => ({
    projects: { getBillingInfo: async () => ({ data: { billingEnabled: false } }) },
  }) as never);
  const linked = await getLinkedBillingAccount({} as never, 'proj-1');
  assert.equal(linked, undefined);
});

test('getLinkedBillingAccount returns the account name when linked', async () => {
  mock.method(google, 'cloudbilling', () => ({
    projects: {
      getBillingInfo: async () => ({
        data: { billingEnabled: true, billingAccountName: 'billingAccounts/012345-ABCDEF-678901' },
      }),
    },
  }) as never);
  const linked = await getLinkedBillingAccount({} as never, 'proj-1');
  assert.equal(linked, 'billingAccounts/012345-ABCDEF-678901');
});

test('canLinkProjects returns true when the permission is granted', async () => {
  const testIamPermissions = mock.fn(async () => ({
    data: { permissions: ['billing.resourceAssociations.create'] },
  }));
  mock.method(google, 'cloudbilling', () => ({ billingAccounts: { testIamPermissions } }) as never);
  const ok = await canLinkProjects({} as never, '012345-ABCDEF-678901');
  assert.equal(ok, true);
  const req = testIamPermissions.mock.calls[0].arguments[0] as { resource: string };
  assert.equal(req.resource, 'billingAccounts/012345-ABCDEF-678901');
});

test('canLinkProjects returns false when the permission is missing', async () => {
  mock.method(google, 'cloudbilling', () => ({
    billingAccounts: { testIamPermissions: async () => ({ data: { permissions: [] } }) },
  }) as never);
  const ok = await canLinkProjects({} as never, '012345-ABCDEF-678901');
  assert.equal(ok, false);
});

test('countLinkedProjects sums projectBillingInfo across pages', async () => {
  const pages: Record<string, unknown> = {
    '': { projectBillingInfo: [{ projectId: 'a' }, { projectId: 'b' }], nextPageToken: 'p2' },
    p2: { projectBillingInfo: [{ projectId: 'c' }] },
  };
  mock.method(google, 'cloudbilling', () => ({
    billingAccounts: { projects: { list: async ({ pageToken = '' }: { pageToken?: string }) => ({ data: pages[pageToken] }) } },
  }) as never);
  assert.equal(await countLinkedProjects({} as never, '0114D0-E45B05-2951AC'), 3);
});
