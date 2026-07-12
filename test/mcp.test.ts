import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { MCP_TOOLS, buildMcpServer } from '../src/mcp.js';

afterEach(() => mock.restoreAll());

/**
 * MCP tool handlers use ADC (they take no `auth` arg), so exercising a handler
 * would otherwise hit real credential resolution — which hangs/fails in CI
 * where there is no ADC. Stub GoogleAuth to hand back a no-network fake client
 * so the mocked google.* APIs are what actually get exercised.
 */
function stubAdc() {
  const fake = { getAccessToken: async () => ({ token: 'fake' }), quotaProjectId: undefined };
  mock.method(GoogleAuth.prototype, 'getClient', async () => fake as never);
}

const tool = (name: string) => {
  const t = MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

/** Parse an input like the MCP runtime does, so schema defaults (apply=false) apply. */
const parse = (name: string, input: Record<string, unknown>) => z.object(tool(name).inputSchema).parse(input);

test('exposes exactly the expected tool set', () => {
  assert.deepEqual(
    MCP_TOOLS.map((t) => t.name).sort(),
    ['gcp_seeder_audit', 'gcp_seeder_destroy', 'gcp_seeder_rotate', 'gcp_seeder_seed', 'gcp_seeder_sweep'],
  );
});

test('audit is read-only; the mutating tools are marked destructive', () => {
  assert.equal(tool('gcp_seeder_audit').annotations?.readOnlyHint, true);
  for (const n of ['gcp_seeder_sweep', 'gcp_seeder_destroy', 'gcp_seeder_rotate']) {
    assert.equal(tool(n).annotations?.destructiveHint, true, `${n} must be flagged destructive`);
  }
  assert.equal(tool('gcp_seeder_seed').annotations?.destructiveHint, false);
});

test('every mutating tool defaults apply=false (dry-run) — the core safety contract', () => {
  assert.equal((parse('gcp_seeder_sweep', {}) as { apply: boolean }).apply, false);
  assert.equal((parse('gcp_seeder_destroy', { projectIds: ['p'] }) as { apply: boolean }).apply, false);
  assert.equal(
    (parse('gcp_seeder_rotate', { projectId: 'p', serviceAccount: 'sa@p.iam.gserviceaccount.com' }) as { apply: boolean }).apply,
    false,
  );
});

test('destroy requires at least one explicit project id', () => {
  assert.throws(() => parse('gcp_seeder_destroy', { projectIds: [] }), /too_?small|at least|greater/i);
});

test('destroy tool dry-runs by default: mutates nothing', async () => {
  stubAdc();
  const del = mock.fn(async () => ({ data: {} }));
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { get: async () => ({ data: { labels: { 'seeded-by': 'gcp-seeder' } } }), delete: del },
  }) as never);
  mock.method(google, 'iam', () => ({ projects: { serviceAccounts: { list: async () => ({ data: { accounts: [] } }) } } }) as never);

  const args = parse('gcp_seeder_destroy', { projectIds: ['seed-x'] }); // apply omitted → false
  const result = (await tool('gcp_seeder_destroy').handler(args as Record<string, unknown>)) as { dryRun: boolean };

  assert.equal(result.dryRun, true);
  assert.equal(del.mock.callCount(), 0, 'dry-run must not delete');
});

test('rotate tool dry-runs by default: mints/deletes nothing', async () => {
  stubAdc();
  const create = mock.fn();
  const del = mock.fn();
  mock.method(google, 'iam', () => ({
    projects: {
      serviceAccounts: {
        keys: {
          list: async () => ({ data: { keys: [{ name: 'projects/p/serviceAccounts/sa/keys/K1' }] } }),
          create,
          delete: del,
        },
      },
    },
  }) as never);

  const args = parse('gcp_seeder_rotate', { projectId: 'p', serviceAccount: 'sa@p.iam.gserviceaccount.com' });
  const result = (await tool('gcp_seeder_rotate').handler(args as Record<string, unknown>)) as { dryRun: boolean };

  assert.equal(result.dryRun, true);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(del.mock.callCount(), 0);
});

test('buildMcpServer registers all tools without throwing', () => {
  assert.doesNotThrow(() => buildMcpServer());
});
