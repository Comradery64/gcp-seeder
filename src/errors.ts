/**
 * Human-readable explanations for the Google API errors gcp-seeder hits most
 * often while bootstrapping a project: quota, org policy, billing permission
 * / quota, the "API not ready yet" 403 (and its quota-project confusion
 * cousin), reauth, burned project ids, and liens.
 *
 * This is a pure mapping layer. It never makes a network call, never prints
 * anything itself, and never lets a secret (bearer token, private key) reach
 * its output. The CLI layer is the one that calls `console.error` /
 * `process.exit`.
 */

export type ExplainedErrorKind =
  | 'quota'
  | 'org-policy'
  | 'billing-permission'
  | 'billing-quota'
  | 'api-not-ready'
  | 'quota-project'
  | 'already-exists'
  | 'reauth'
  | 'permission'
  | 'lien'
  | 'unknown';

export interface ExplainedError {
  kind: ExplainedErrorKind;
  headline: string;
  fix?: string;
  docs?: string;
  /** The raw message, redacted of anything secret-shaped and trimmed to 500 chars. */
  original: string;
}

export interface ExplainGoogleErrorContext {
  /** The project gcp-seeder is targeting (not necessarily the caller's quota project). */
  projectId?: string;
  parent?: string;
  billingAccount?: string;
}

const MAX_ORIGINAL_LENGTH = 500;

// --- error shape extraction --------------------------------------------------

/** googleapis errors carry a numeric `code`; some transports stringify it. */
function getCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  return undefined;
}

/** googleapis errors sometimes carry `response.data.error.status` (e.g. "RESOURCE_EXHAUSTED"). */
function getStatus(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const response = (err as { response?: { data?: { error?: { status?: unknown } } } }).response;
  const status = response?.data?.error?.status;
  return typeof status === 'string' ? status : undefined;
}

function getMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const maybe = err as { message?: unknown; errors?: Array<{ message?: unknown }> };
    if (typeof maybe.message === 'string') return maybe.message;
    if (Array.isArray(maybe.errors) && typeof maybe.errors[0]?.message === 'string') {
      return maybe.errors[0].message as string;
    }
    try {
      return JSON.stringify(err);
    } catch {
      // fall through
    }
  }
  return String(err);
}

// --- redaction ---------------------------------------------------------------

/** Never let a bearer token or private key reach the rendered explanation. */
function redact(msg: string): string {
  let out = msg.replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted]');
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[redacted]',
  );
  return out;
}

// --- pattern extractors -------------------------------------------------------

/** e.g. "constraints/iam.disableServiceAccountKeyCreation" */
function extractConstraint(msg: string): string | undefined {
  const m = msg.match(/constraints\/[a-zA-Z.]+/);
  return m?.[0];
}

/** The project number in "... has not been used in project 123456 before ..." */
function extractProjectNumber(msg: string): string | undefined {
  const m = msg.match(/project (\d+)/i);
  return m?.[1];
}

/** The resource in "... denied on resource 'projects/foo' ..." */
function extractResource(msg: string): string | undefined {
  const m = msg.match(/denied on resource '([^']+)'/i);
  return m?.[1];
}

// --- main entry point ---------------------------------------------------------

export function explainGoogleError(err: unknown, ctx: ExplainGoogleErrorContext = {}): ExplainedError {
  const code = getCode(err);
  const status = getStatus(err);
  const rawMessage = getMessage(err);
  const original = redact(rawMessage).trim().slice(0, MAX_ORIGINAL_LENGTH);
  const msg = rawMessage;

  // 1. Org policy violation.
  if (/violates constraint|orgpolicy|constraints\//i.test(msg)) {
    const constraint = extractConstraint(msg);
    const isKeyCreationConstraint = constraint === 'constraints/iam.disableServiceAccountKeyCreation';
    return {
      kind: 'org-policy',
      headline: `Blocked by org policy${constraint ? ` ${constraint}` : ''}.`,
      fix: isKeyCreationConstraint
        ? 'Service account key creation is disabled by org policy. Use workload identity federation instead of a downloadable key: re-run with --wif github:owner/repo or --wif gitlab:group/project.'
        : `Ask an org or folder admin to grant an exception for this project, or update the org policy constraint${constraint ? ` ${constraint}` : ''}.`,
      original,
    };
  }

  // 2. Billing account quota (projects-per-billing-account cap), checked before the
  //    generic billing-permission case since both are 4xx + mention "billing".
  if (/precondition check failed/i.test(msg) && /billing/i.test(msg)) {
    const acct = ctx.billingAccount ?? '<id>';
    return {
      kind: 'billing-quota',
      headline: `Billing account ${acct} has hit its projects-per-billing-account quota (default 5).`,
      fix: 'Unlink an unused project from the billing account, or request an increase.',
      docs: `https://console.cloud.google.com/billing/${acct}/manage`,
      original,
    };
  }

  // 3. Billing permission (403, mentions billing).
  if ((code === 403 || /permission_denied/i.test(msg)) && /billing/i.test(msg)) {
    const acct = ctx.billingAccount ?? 'the billing account';
    return {
      kind: 'billing-permission',
      headline: `Missing permission to link billing account ${acct}.`,
      fix: 'You need roles/billing.user ON THE BILLING ACCOUNT itself — an org-level grant is not enough when the account lives outside the org.',
      original,
    };
  }

  // 4. "API not ready" 403 — also the classic quota-project confusion: the message
  //    names the credentials' quota project, not necessarily the target project.
  if (/has not been used in project/i.test(msg) || /or it is disabled/i.test(msg)) {
    const projectNumber = extractProjectNumber(msg);
    const targetMismatch = Boolean(
      projectNumber && ctx.projectId && projectNumber !== ctx.projectId,
    );
    if (targetMismatch) {
      return {
        kind: 'quota-project',
        headline: `This 403 names project ${projectNumber} — your credentials' quota project — not your target project ${ctx.projectId}.`,
        fix: `Set the quota project explicitly: gcloud auth application-default set-quota-project ${ctx.projectId}, or pass the header x-goog-user-project: ${ctx.projectId} on the request.`,
        original,
      };
    }
    return {
      kind: 'api-not-ready',
      headline: `The API isn't usable yet for project ${projectNumber ?? '(unknown)'} — enabling can take a few minutes to propagate.`,
      fix: "Wait a minute or two and retry. gcp-seeder's readiness polling handles this automatically during seed; if you're calling the API directly, add a short retry loop.",
      original,
    };
  }

  // 5. Reauth challenge.
  if (/invalid_rapt/i.test(msg) || /reauth/i.test(msg)) {
    return {
      kind: 'reauth',
      headline: 'Your Application Default Credentials need to be refreshed (a reauth challenge).',
      fix: 'Run: gcloud auth application-default login',
      original,
    };
  }

  // 6. Delete lien.
  if (/project_delete_lien/i.test(msg) || /\blien\b/i.test(msg)) {
    return {
      kind: 'lien',
      headline: 'Project deletion is blocked by a lien (Shared VPC often adds one automatically).',
      fix: 'Remove the lien(s) first: gcp-seeder destroy --remove-liens',
      original,
    };
  }

  // 7. Burned / already-taken project id.
  if (code === 409 || /already exists/i.test(msg)) {
    return {
      kind: 'already-exists',
      headline: `Project id${ctx.projectId ? ` "${ctx.projectId}"` : ''} is already taken.`,
      fix: 'Project ids are global and never reusable after deletion. Pick another id, or omit --project-id to let gcp-seeder generate one.',
      original,
    };
  }

  // 8. Project quota (RESOURCE_EXHAUSTED, or "quota" alongside "project").
  if (
    status === 'RESOURCE_EXHAUSTED' ||
    /resource_exhausted/i.test(msg) ||
    (/quota/i.test(msg) && /project/i.test(msg))
  ) {
    return {
      kind: 'quota',
      headline: "You've hit (or are near) Google's default project quota (~30 projects per caller).",
      fix: 'Soft-deleted projects still count against quota for 30 days. Delete unused projects, or request a quota increase.',
      docs: 'https://support.google.com/code/contact/project_quota_increase',
      original,
    };
  }

  // 9. Generic permission denied.
  if (code === 403 || /permission_denied/i.test(msg)) {
    const resource = extractResource(msg);
    return {
      kind: 'permission',
      headline: `Permission denied${resource ? ` on resource '${resource}'` : ''}.`,
      fix: 'Check that the caller has the right IAM role on the resource, and that the relevant API is enabled.',
      original,
    };
  }

  // 10. Unknown.
  return {
    kind: 'unknown',
    headline: `Unrecognized error${code ? ` (code ${code})` : ''}.`,
    original,
  };
}

/** Multi-line, terminal-friendly rendering (no ANSI colors). */
export function formatExplainedError(e: ExplainedError): string {
  const lines = [e.headline, ''];
  if (e.fix) lines.push(`Fix: ${e.fix}`);
  if (e.docs) lines.push(`Docs: ${e.docs}`);
  lines.push(`Original: ${e.original}`);
  return lines.join('\n');
}
