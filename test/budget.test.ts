import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import { ensureBudget, ensureTopic, writeKillSwitchTemplate } from '../src/budget.js';

const execFileAsync = promisify(execFile);

afterEach(() => mock.restoreAll());

const BILLING_ACCOUNT = 'billingAccounts/012345-ABCDEF-678901';

test('ensureBudget reuses an existing budget by displayName instead of creating one', async () => {
  const list = mock.fn(async () => ({
    data: {
      budgets: [
        {
          name: 'billingAccounts/012345-ABCDEF-678901/budgets/existing-1',
          displayName: 'gcp-seeder:my-proj',
          notificationsRule: { pubsubTopic: 'projects/my-proj/topics/gcp-seeder-budget' },
        },
      ],
    },
  }));
  const create = mock.fn(async () => ({ data: { name: 'should-not-be-called' } }));
  mock.method(google, 'billingbudgets', () => ({ billingAccounts: { budgets: { list, create } } }) as never);

  const lines: string[] = [];
  const result = await ensureBudget(
    {} as never,
    { billingAccount: BILLING_ACCOUNT, projectNumber: '999', projectId: 'my-proj', amountUsd: 50 },
    (m) => lines.push(m),
  );

  assert.equal(create.mock.callCount(), 0);
  assert.equal(list.mock.callCount(), 1);
  assert.deepEqual(result, {
    name: 'billingAccounts/012345-ABCDEF-678901/budgets/existing-1',
    displayName: 'gcp-seeder:my-proj',
    existed: true,
    pubsubTopic: 'projects/my-proj/topics/gcp-seeder-budget',
  });
  assert.ok(lines.some((l) => l.includes('already exists')));
});

test('ensureBudget creates a budget with the exact filter, units, thresholds, topic, and quota header', async () => {
  const list = mock.fn(async () => ({ data: { budgets: [] } }));
  const create = mock.fn(async () => ({
    data: { name: 'billingAccounts/012345-ABCDEF-678901/budgets/new-1' },
  }));
  mock.method(google, 'billingbudgets', () => ({ billingAccounts: { budgets: { list, create } } }) as never);

  const result = await ensureBudget({} as never, {
    billingAccount: '012345-ABCDEF-678901',
    projectNumber: '999888777',
    projectId: 'my-proj',
    amountUsd: 50.9,
    pubsubTopic: 'projects/my-proj/topics/gcp-seeder-budget',
  });

  assert.equal(create.mock.callCount(), 1);
  const req = create.mock.calls[0].arguments[0] as {
    parent: string;
    headers: Record<string, string>;
    requestBody: {
      displayName: string;
      budgetFilter: { projects: string[] };
      amount: { specifiedAmount: { currencyCode: string; units: string } };
      thresholdRules: Array<{ thresholdPercent: number }>;
      notificationsRule?: { pubsubTopic: string; schemaVersion: string };
    };
  };
  assert.equal(req.parent, 'billingAccounts/012345-ABCDEF-678901');
  assert.deepEqual(req.headers, { 'x-goog-user-project': 'my-proj' });
  assert.equal(req.requestBody.displayName, 'gcp-seeder:my-proj');
  assert.deepEqual(req.requestBody.budgetFilter.projects, ['projects/999888777']);
  assert.equal(req.requestBody.amount.specifiedAmount.currencyCode, 'USD');
  assert.equal(req.requestBody.amount.specifiedAmount.units, '50');
  assert.equal(typeof req.requestBody.amount.specifiedAmount.units, 'string');
  assert.deepEqual(
    req.requestBody.thresholdRules.map((r) => r.thresholdPercent),
    [0.5, 0.9, 1.0],
  );
  assert.deepEqual(req.requestBody.notificationsRule, {
    pubsubTopic: 'projects/my-proj/topics/gcp-seeder-budget',
    schemaVersion: '1.0',
  });
  assert.deepEqual(result, {
    name: 'billingAccounts/012345-ABCDEF-678901/budgets/new-1',
    displayName: 'gcp-seeder:my-proj',
    existed: false,
    pubsubTopic: 'projects/my-proj/topics/gcp-seeder-budget',
  });
});

test('ensureBudget honors custom thresholds and omits notificationsRule with no topic', async () => {
  const list = mock.fn(async () => ({ data: { budgets: [] } }));
  const create = mock.fn(async () => ({ data: { name: 'billingAccounts/x/budgets/new-2' } }));
  mock.method(google, 'billingbudgets', () => ({ billingAccounts: { budgets: { list, create } } }) as never);

  await ensureBudget({} as never, {
    billingAccount: BILLING_ACCOUNT,
    projectNumber: '1',
    projectId: 'p',
    amountUsd: 10,
    thresholds: [0.25, 0.75],
  });

  const req = create.mock.calls[0].arguments[0] as {
    requestBody: { thresholdRules: Array<{ thresholdPercent: number }>; notificationsRule?: unknown };
  };
  assert.deepEqual(
    req.requestBody.thresholdRules.map((r) => r.thresholdPercent),
    [0.25, 0.75],
  );
  assert.equal(req.requestBody.notificationsRule, undefined);
});

test('ensureTopic creates the topic and returns its full resource name', async () => {
  const create = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'pubsub', () => ({ projects: { topics: { create } } }) as never);

  const lines: string[] = [];
  const name = await ensureTopic({} as never, 'my-proj', 'gcp-seeder-budget', (m) => lines.push(m));

  assert.equal(name, 'projects/my-proj/topics/gcp-seeder-budget');
  assert.equal(create.mock.callCount(), 1);
  assert.deepEqual(create.mock.calls[0].arguments[0], { name: 'projects/my-proj/topics/gcp-seeder-budget' });
  assert.ok(lines.some((l) => l.includes('created')));
});

test('ensureTopic treats a 409 as already existing (idempotent)', async () => {
  const create = mock.fn(async () => {
    throw Object.assign(new Error('Topic already exists'), { code: 409 });
  });
  mock.method(google, 'pubsub', () => ({ projects: { topics: { create } } }) as never);

  const lines: string[] = [];
  const name = await ensureTopic({} as never, 'my-proj', 'gcp-seeder-budget', (m) => lines.push(m));

  assert.equal(name, 'projects/my-proj/topics/gcp-seeder-budget');
  assert.ok(lines.some((l) => l.includes('already exists')));
});

test('ensureTopic rethrows unrelated errors', async () => {
  const boom = Object.assign(new Error('PERMISSION_DENIED'), { code: 403 });
  const create = mock.fn(async () => {
    throw boom;
  });
  mock.method(google, 'pubsub', () => ({ projects: { topics: { create } } }) as never);

  await assert.rejects(ensureTopic({} as never, 'my-proj', 'gcp-seeder-budget'), (e) => e === boom);
});

test('writeKillSwitchTemplate writes index.js, package.json, README.md with the deploy command and topic', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'gcp-seeder-budget-'));
  try {
    const dir = await writeKillSwitchTemplate(outputDir, {
      billingAccount: BILLING_ACCOUNT,
      projectNumber: '999',
      projectId: 'my-proj',
      amountUsd: 5,
      topic: 'gcp-seeder-budget',
    });

    assert.equal(dir, path.join(outputDir, 'billing-killswitch'));

    const indexPath = path.join(dir, 'index.js');
    const pkgPath = path.join(dir, 'package.json');
    const readmePath = path.join(dir, 'README.md');

    const [indexJs, pkgRaw, readmeText] = await Promise.all([
      readFile(indexPath, 'utf8'),
      readFile(pkgPath, 'utf8'),
      readFile(readmePath, 'utf8'),
    ]);

    // Plain files (0644), not secrets (0600).
    for (const p of [indexPath, pkgPath, readmePath]) {
      const s = await stat(p);
      assert.equal(s.mode & 0o777, 0o644, `${p} should be mode 0644`);
    }

    // index.js is valid, syntactically parseable Node CommonJS.
    await execFileAsync(process.execPath, ['--check', indexPath]);
    assert.match(indexJs, /exports\.billingKillSwitch/);
    assert.match(indexJs, /updateBillingInfo/);
    assert.match(indexJs, /billingAccountName: ''/);
    assert.match(indexJs, /getBillingInfo/); // guard against re-running when already unlinked
    assert.match(indexJs, /my-proj/);

    const pkg = JSON.parse(pkgRaw);
    assert.ok(pkg.dependencies.googleapis);
    assert.ok(pkg.dependencies['google-auth-library']);

    assert.match(readmeText, /gcloud functions deploy/);
    assert.match(readmeText, /--gen2/);
    assert.match(readmeText, /--runtime=nodejs20/);
    assert.match(readmeText, /--trigger-topic=gcp-seeder-budget/);
    assert.match(readmeText, /roles\/billing\.projectManager/);
    assert.match(readmeText, /DISABLES BILLING/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
