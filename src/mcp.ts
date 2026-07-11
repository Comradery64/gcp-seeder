import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { auditCloud } from './audit.js';
import { destroyProjects } from './destroy.js';
import { rotateServiceAccountKey } from './rotate.js';
import { seedProject } from './seeder.js';
import { sweepProjects } from './sweep.js';
import { parseWifTarget } from './wif.js';
import { VERSION } from './version.js';

/**
 * The MCP stdio transport uses **stdout** as the protocol channel, so any
 * progress written there would corrupt the stream. All tool handlers route the
 * seeder's progress to stderr instead.
 */
const mcpLog = (m: string) => console.error(m);

/** Reused so `apply` is off unless an agent explicitly opts in. */
const applyFlag = z
  .boolean()
  .default(false)
  .describe('Must be set true to actually mutate. Default false = dry-run (nothing is changed).');

interface McpTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The tools exposed over MCP. Exported so the safety contract (dry-run defaults
 * on every mutating tool) can be unit-tested without standing up a transport.
 *
 * Safety model: `audit` is read-only; `seed` creates resources and is marked
 * non-destructive; `sweep`/`destroy`/`rotate` are destructive and **default to
 * dry-run** — an agent must pass `apply: true` to change anything, and even
 * then `destroy` still refuses non-owned projects unless `force: true`.
 */
export const MCP_TOOLS: McpTool[] = [
  {
    name: 'gcp_seeder_audit',
    description:
      'Read-only. Scan visible GCP projects for seeder-owned/orphan projects, static service-account keys (flag stale ones via maxKeyAge, e.g. "90d"), Workload Identity Federation providers, and domain-wide-delegation client ids.',
    inputSchema: {
      projectIds: z.array(z.string()).optional().describe('Restrict the scan to these project ids'),
      maxKeyAge: z.string().optional().describe('Flag user-managed keys older than this (e.g. "90d") as stale'),
      flagPatterns: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (a) =>
      auditCloud({
        projectIds: a.projectIds as string[] | undefined,
        maxKeyAge: a.maxKeyAge as string | undefined,
        flagPatterns: a.flagPatterns as string[] | undefined,
        logger: mcpLog,
      }),
  },
  {
    name: 'gcp_seeder_seed',
    description:
      'Create a GCP project: enable APIs, optionally a service account and keyless GitHub Actions auth (WIF), and stamp ownership + TTL labels. Creates real cloud resources.',
    inputSchema: {
      projectId: z.string().optional(),
      displayName: z.string().optional(),
      parent: z.string().optional().describe('organizations/123 or folders/456'),
      apis: z.array(z.string()).optional().describe('serviceusage names, e.g. ["run.googleapis.com"]'),
      serviceAccount: z.boolean().optional().describe('Also create a default service account'),
      wif: z.string().optional().describe('Keyless GitHub Actions auth, e.g. "github:owner/repo"'),
      ttl: z.string().optional().describe('Expiry for sweep to reclaim, e.g. "30d"'),
      outputDir: z.string().optional(),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: (a) =>
      seedProject({
        projectId: a.projectId as string | undefined,
        displayName: a.displayName as string | undefined,
        parent: a.parent as string | undefined,
        apis: (a.apis as string[] | undefined) ?? [],
        credentials: { serviceAccount: Boolean(a.serviceAccount) || Boolean(a.wif), oauthClient: false },
        wif: a.wif ? parseWifTarget(a.wif as string) : undefined,
        ttl: a.ttl as string | undefined,
        outputDir: a.outputDir as string | undefined,
        logger: mcpLog,
      }),
  },
  {
    name: 'gcp_seeder_sweep',
    description:
      'Find seeder-owned projects and delete the expired (and, with maxAge, stale) ones. DRY-RUN BY DEFAULT — pass apply=true to actually soft-delete (~30-day recovery).',
    inputSchema: {
      apply: applyFlag,
      maxAge: z.string().optional().describe('Also sweep projects older than this even without an expiry (e.g. "30d")'),
      flagPatterns: z.array(z.string()).optional(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: (a) =>
      sweepProjects({
        apply: a.apply as boolean,
        maxAge: a.maxAge as string | undefined,
        flagPatterns: a.flagPatterns as string[] | undefined,
        logger: mcpLog,
      }),
  },
  {
    name: 'gcp_seeder_destroy',
    description:
      'Tear down explicitly-named projects (revoke static keys + WIF pools, then soft-delete). DRY-RUN BY DEFAULT — pass apply=true to mutate. Refuses non-seeder-owned projects unless force=true.',
    inputSchema: {
      projectIds: z.array(z.string()).min(1).describe('Explicit project ids — never wildcards'),
      apply: applyFlag,
      keysOnly: z.boolean().optional().describe('Only revoke standing credentials; keep the project'),
      force: z.boolean().optional().describe('Allow projects that are not seeder-owned / orphan-matched'),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: (a) =>
      destroyProjects({
        projectIds: a.projectIds as string[],
        apply: a.apply as boolean,
        keysOnly: a.keysOnly as boolean | undefined,
        force: a.force as boolean | undefined,
        logger: mcpLog,
      }),
  },
  {
    name: 'gcp_seeder_rotate',
    description:
      'Rotate a service account key: mint a new key, then disable + delete the old one(s). DRY-RUN BY DEFAULT — pass apply=true to rotate (deleting the old key is irreversible).',
    inputSchema: {
      projectId: z.string(),
      serviceAccount: z.string().describe('Service account email'),
      keyId: z.string().optional().describe('Rotate only this key id (default: all user-managed keys)'),
      apply: applyFlag,
      outputDir: z.string().optional(),
    },
    annotations: { destructiveHint: true },
    handler: (a) =>
      rotateServiceAccountKey({
        projectId: a.projectId as string,
        serviceAccountEmail: a.serviceAccount as string,
        keyId: a.keyId as string | undefined,
        apply: a.apply as boolean,
        outputDir: a.outputDir as string | undefined,
        logger: mcpLog,
      }),
  },
];

/** Build the MCP server with all tools registered (no transport attached yet). */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'gcp-seeder', version: VERSION });
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args: Record<string, unknown>) => {
        const result = await tool.handler(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }
  return server;
}

/** Run the stdio MCP server until the client disconnects. */
export async function runMcpServer(): Promise<void> {
  const server = buildMcpServer();
  await server.connect(new StdioServerTransport());
}
