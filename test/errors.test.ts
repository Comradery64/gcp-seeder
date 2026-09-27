import test from 'node:test';
import assert from 'node:assert/strict';
import { explainGoogleError, formatExplainedError, type ExplainedError } from '../src/errors.js';

function googleErr(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

// --- one test per `kind` -----------------------------------------------------

test('kind: quota — project quota exhausted', () => {
  const e = explainGoogleError(
    googleErr("RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Number of projects' for this caller.", {
      code: 429,
      response: { data: { error: { status: 'RESOURCE_EXHAUSTED' } } },
    }),
  );
  assert.equal(e.kind, 'quota');
  assert.match(e.headline, /quota/i);
  assert.ok(e.fix);
  assert.match(e.docs ?? '', /project_quota_increase/);
});

test('kind: org-policy — generic constraint violation', () => {
  const e = explainGoogleError(
    googleErr(
      'Operation denied by org policy: violates constraint constraints/compute.skipDefaultNetworkCreation on projects/my-proj.',
      { code: 400 },
    ),
  );
  assert.equal(e.kind, 'org-policy');
  assert.match(e.headline, /constraints\/compute\.skipDefaultNetworkCreation/);
  assert.doesNotMatch(e.fix ?? '', /--wif/);
});

test('kind: billing-permission — 403 linking billing account', () => {
  const e = explainGoogleError(
    googleErr('PERMISSION_DENIED: The caller does not have permission to link billing account.', { code: 403 }),
    { billingAccount: 'billingAccounts/012345-ABCDEF-678901' },
  );
  assert.equal(e.kind, 'billing-permission');
  assert.match(e.headline, /billingAccounts\/012345-ABCDEF-678901/);
  assert.match(e.fix ?? '', /roles\/billing\.user/);
});

test('kind: billing-quota — projects-per-billing-account cap', () => {
  const e = explainGoogleError(
    googleErr(
      'FAILED_PRECONDITION: Precondition check failed. Billing account billingAccounts/012345-ABCDEF-678901 has reached the maximum number of associated projects.',
      { code: 400 },
    ),
    { billingAccount: 'billingAccounts/012345-ABCDEF-678901' },
  );
  assert.equal(e.kind, 'billing-quota');
  assert.match(e.headline, /projects-per-billing-account quota/);
  assert.match(e.docs ?? '', /console\.cloud\.google\.com\/billing\/billingAccounts\/012345-ABCDEF-678901\/manage/);
});

test('kind: api-not-ready — API not yet usable, project matches ctx', () => {
  const e = explainGoogleError(
    googleErr(
      'PERMISSION_DENIED: Cloud Resource Manager API has not been used in project 555555 before or it is disabled. Enable it and retry.',
      { code: 403 },
    ),
    { projectId: '555555' },
  );
  assert.equal(e.kind, 'api-not-ready');
  assert.match(e.headline, /555555/);
  assert.doesNotMatch(e.headline, /quota project/i);
});

test('kind: quota-project — API-not-ready message names a different project than the target', () => {
  const e = explainGoogleError(
    googleErr(
      'PERMISSION_DENIED: Cloud Resource Manager API has not been used in project 999999 before or it is disabled. Enable it and retry.',
      { code: 403 },
    ),
    { projectId: 'my-target-project' },
  );
  assert.equal(e.kind, 'quota-project');
  assert.match(e.headline, /999999/);
  assert.match(e.headline, /my-target-project/);
  assert.match(e.fix ?? '', /set-quota-project my-target-project/);
});

test('kind: reauth — invalid_rapt reauth challenge', () => {
  const e = explainGoogleError(googleErr('invalid_rapt: reauthentication required to continue.', { code: 403 }));
  assert.equal(e.kind, 'reauth');
  assert.match(e.fix ?? '', /gcloud auth application-default login/);
});

test('kind: already-exists — burned/taken project id', () => {
  const e = explainGoogleError(
    googleErr('Requested entity already exists', { code: 409 }),
    { projectId: 'already-taken-123' },
  );
  assert.equal(e.kind, 'already-exists');
  assert.match(e.headline, /already-taken-123/);
  assert.match(e.fix ?? '', /never reusable/);
});

test('kind: permission — generic 403 with a named resource', () => {
  const e = explainGoogleError(
    googleErr("PERMISSION_DENIED: Permission 'resourcemanager.projects.get' denied on resource 'projects/my-project'.", {
      code: 403,
    }),
  );
  assert.equal(e.kind, 'permission');
  assert.match(e.headline, /projects\/my-project/);
});

test('kind: lien — delete blocked by a project lien', () => {
  const e = explainGoogleError(
    googleErr('FAILED_PRECONDITION: Cannot delete project, it has a lien: PROJECT_DELETE_LIEN', { code: 400 }),
  );
  assert.equal(e.kind, 'lien');
  assert.match(e.fix ?? '', /--remove-liens/);
});

test('kind: unknown — an error message matching nothing', () => {
  const e = explainGoogleError(googleErr('some completely unrelated internal error'));
  assert.equal(e.kind, 'unknown');
  assert.equal(e.fix, undefined);
  assert.equal(e.docs, undefined);
});

// --- additional required coverage -------------------------------------------

test('unknown non-Error input does not throw and is labeled unknown', () => {
  const e1 = explainGoogleError(42);
  assert.equal(e1.kind, 'unknown');
  assert.equal(e1.original, '42');

  const e2 = explainGoogleError({});
  assert.equal(e2.kind, 'unknown');

  const e3 = explainGoogleError(null);
  assert.equal(e3.kind, 'unknown');
});

test('ctx-driven wording for api-not-ready differs between matching and non-matching project', () => {
  const message =
    'PERMISSION_DENIED: Cloud Resource Manager API has not been used in project 123456 before or it is disabled.';
  const matching = explainGoogleError(googleErr(message, { code: 403 }), { projectId: '123456' });
  const mismatched = explainGoogleError(googleErr(message, { code: 403 }), { projectId: 'other-project' });
  assert.equal(matching.kind, 'api-not-ready');
  assert.equal(mismatched.kind, 'quota-project');
  assert.notEqual(matching.headline, mismatched.headline);
  assert.match(mismatched.headline, /credentials' quota project/);
});

test('constraint-name extraction pulls the exact constraints/... token out of the message', () => {
  const e = explainGoogleError(
    googleErr('violates constraint constraints/gcp.restrictServiceUsage on this project.', { code: 400 }),
  );
  assert.equal(e.kind, 'org-policy');
  assert.match(e.headline, /constraints\/gcp\.restrictServiceUsage/);
});

test('org-policy on iam.disableServiceAccountKeyCreation points at WIF', () => {
  const e = explainGoogleError(
    googleErr('violates constraint constraints/iam.disableServiceAccountKeyCreation for this project.', { code: 400 }),
  );
  assert.equal(e.kind, 'org-policy');
  assert.match(e.headline, /constraints\/iam\.disableServiceAccountKeyCreation/);
  assert.match(e.fix ?? '', /--wif github:owner\/repo/);
  assert.match(e.fix ?? '', /--wif gitlab:group\/project/);
});

test('redaction: a bearer token and a private key block never reach the rendered message', () => {
  const token = 'ya29.a0AfH6SMBxyz1234567890-_abcDEF';
  const key =
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n-----END PRIVATE KEY-----';
  const e = explainGoogleError(googleErr(`some totally unrelated error, token=${token}, key=${key}`));
  assert.equal(e.kind, 'unknown');
  assert.doesNotMatch(e.original, /ya29\./);
  assert.doesNotMatch(e.original, /BEGIN PRIVATE KEY/);
  assert.match(e.original, /\[redacted\]/);
});

test('original is trimmed to 500 characters', () => {
  const long = 'x'.repeat(1000);
  const e = explainGoogleError(googleErr(long));
  assert.equal(e.original.length, 500);
});

// --- formatExplainedError ----------------------------------------------------

test('formatExplainedError renders headline, blank line, Fix, Docs, then Original', () => {
  const explained: ExplainedError = {
    kind: 'quota',
    headline: 'Headline text.',
    fix: 'Do this.',
    docs: 'https://example.com/docs',
    original: 'raw message',
  };
  const rendered = formatExplainedError(explained);
  assert.equal(
    rendered,
    'Headline text.\n\nFix: Do this.\nDocs: https://example.com/docs\nOriginal: raw message',
  );
  assert.doesNotMatch(rendered, /\x1b\[/, 'no ANSI escape codes');
});

test('formatExplainedError omits Fix/Docs lines when absent', () => {
  const explained: ExplainedError = {
    kind: 'unknown',
    headline: 'Unrecognized error.',
    original: 'raw message',
  };
  const rendered = formatExplainedError(explained);
  assert.equal(rendered, 'Unrecognized error.\n\nOriginal: raw message');
});

test('billing-quota: recognizes the message src/billing.ts already rewrote and extracts the account', () => {
  const e = explainGoogleError(
    new Error('Billing account 0114D0-E45B05-2951AC has hit its projects-per-billing-account quota (default 5). Unlink a project or request an increase.'),
  );
  assert.equal(e.kind, 'billing-quota');
  assert.match(e.headline, /0114D0-E45B05-2951AC/);
  assert.doesNotMatch(e.headline, /~30 projects/);
});
