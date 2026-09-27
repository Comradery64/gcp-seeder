# ORCHESTRATION — v0.5 bootstrap hardening

Routing and spend plan for [`PLAN-v0.5.md`](./PLAN-v0.5.md), per the frugal-fable
policy: lowest sufficient effort first, delegation second, judgment stays with
the orchestrator. Written 2026-09-25 so the next session inherits priors instead
of re-deriving them.

## Harness choice

Inline `Agent` calls with `isolation: "worktree"` (not a `Workflow`), all ten
launched at once. Reason: every worker must run `npm ci` + the test suite in a
clean checkout and hand back a **patch file**, and worktree isolation is the
simplest way to guarantee ten concurrent workers never touch the same working
tree. Context firewall: workers write to
`.frugal-fable/v0.5/<slice>/` (gitignored) and return only path + 3-line summary
+ confidence.

Worker deliverables (absolute paths, so they work from any worktree):

```
<repo>/.frugal-fable/v0.5/<slice>/patch.diff   # git diff --cached --binary vs branch base
<repo>/.frugal-fable/v0.5/<slice>/report.md     # what/why/tests/open questions
<repo>/.frugal-fable/v0.5/<slice>/README-section.md  # the README text for this feature
```

## Routing table (static floor; ▲ = logged upward override)

Scored on stakes / reversibility / ambiguity; highest axis sets both floors.

| Slice | Owner | Effort | Why this floor | Gate |
| --- | --- | --- | --- | --- |
| Wave 0: branch, `src/iam.ts` RMW primitive, plan docs | **Fable** | high (decompose) | shared-file design + security-critical IAM write path | 69/69 tests |
| A billing | Sonnet | medium | mutating, but bounded API surface; error-text mapping needs care | typecheck + tests |
| B roles | ▲ **Opus** | medium | IAM grants ship to prod; wrong member string = silent no-op or over-grant | typecheck + tests + Fable diff review |
| C readiness | Sonnet | medium | well-specified polling; probe table is judgment but low stakes | typecheck + tests |
| D preflight | Sonnet | medium | largest slice, read-only, many independent checks | typecheck + tests |
| E budget | Sonnet | medium | mutating billing-account resource; quota-project header is a known trap | typecheck + tests |
| F harden | ▲ **Opus** | medium | deletes a network + removes an IAM binding; one-way-ish (network recreatable, SA demotion reversible, but must never delete the SA) | typecheck + tests + Fable diff review |
| G errors | Sonnet | low | pure function, exhaustive tests | typecheck + tests |
| H destroy liens/empty | Sonnet | medium | destructive path, but guarded by existing dry-run/ownership rails | typecheck + tests |
| I sweep recipes | Sonnet | low | docs + YAML + bash; correctness of gcloud flags | yaml parse, `bash -n`, actionlint if present |
| J wif gitlab | ▲ **Opus** | medium | security boundary: attribute condition must lock to the exact project; undelete logic | typecheck + tests + Fable diff review |
| Wave 2 integration (shared files) | **Fable** | low (mechanical) → medium if a patch does not apply cleanly | never delegated | typecheck + full suite per step |
| Wave 3 verify A/B/F/J | Sonnet | medium | adversarial; break-the-guard-once | report only |
| Wave 3 documented-path run | Sonnet | low | mechanical | report only |
| Wave 3 output reduction | Haiku | low | log/test reduction | — |
| Wave 4 final review + push | **Fable** | medium | ships to a public npm package | full suite green |

Upward overrides logged: B, F, J → Opus because they are correctness/security
critical and the effort curve on those is steep; a low-effort agent could return
`confidence: high` on a wrong condition string. Everything else starts at the
floor; a failed gate, a `low` confidence return, or a stopped-short report is the
only thing that bumps a slice (effort first, then tier), one re-run max.

## Dependency graph

```
wave 0 (Fable): branch ─ src/iam.ts ─ docs
      │
      ├─ A billing ──────────┐
      ├─ B roles (uses iam) ─┤
      ├─ C readiness ────────┤
      ├─ D preflight (imports A's billing.ts; mocks it) ─┤
      ├─ E budget ───────────┤   all parallel; NO shared-file edits
      ├─ F harden (uses iam) ┤
      ├─ G errors ───────────┤
      ├─ H destroy/liens ────┤
      ├─ I recipes ──────────┤
      └─ J wif gitlab ───────┘
      │
wave 2 (Fable, serial): G → A → C → B → E → F → D → H → J → I → README
      │
wave 3 (parallel): verify A/B/F/J · documented-path · output reduction
      │
wave 4 (Fable): review, push branch. User: live smoke checklist. No PR.
```

The only cross-slice import is D → A (`resolveBillingAccount`, `canLinkProjects`);
D mocks it in tests, so it builds even if A lands later. Everything else touches
only its own new files (H owns `destroy.ts`, J owns `wif.ts` + the `WifTarget`
type, A owns `export.ts`).

## Stop conditions given to every worker

Stop and report (do not improvise) if: the spec does not match the code you find;
a command fails after one retry; the task needs a file outside your allowed set;
`npm test` on the base branch is not green before you start.

## Cost record (2026-09-25 run)

| Slice | Tier/effort run | Escalated? | Notes |
| --- | --- | --- | --- |
| A billing | Sonnet/medium ×2 | no (re-dispatched) | first run stopped on the worktree-base mismatch (see below); retry landed clean, 96→115 tests |
| B roles | Opus/medium | no | self-corrected the worktree base; broke-the-guard on the member string |
| C readiness | Sonnet/medium | no | substituted one probe (firestore has no pageSize) |
| D preflight | Sonnet/medium | no | largest slice; shipped a billing stub that integration excluded |
| E budget | Sonnet/medium ×2 | no (re-dispatched) | first run refused a reset in what had become the shared checkout — correct behaviour |
| F harden | Opus/medium | no | sandbox blocked writing to the main scratch dir; artifacts copied from its worktree |
| G errors | Sonnet/low | no | 19 tests; resolved the api-not-ready vs quota-project ambiguity itself |
| H destroy | Sonnet/medium | no | extended types locally; integration folded them into types.ts |
| I recipes | Sonnet/low | no | actionlint clean; ENTRYPOINT/CMD split for dry-run override |
| J wif | Opus/medium | no | condition + principal asserted exactly; undelete path tested |
| Wave 2 integration | Fable/low | no | 9 seed-path tests needed a `services.get` mock; 1 assertion relaxed (probe re-reads the project) |
| Wave 3 | Sonnet ×3 | — | README assembly, adversarial verify, documented-path run |

**Environment lesson:** `Agent` worktree isolation created most worktrees from
`main` (7ed1fbe), not the current branch HEAD. Seven workers noticed and
`git reset --hard` to the stated base on their own; two stopped and were
re-dispatched with an explicit "reset if HEAD differs" instruction. When a
stopped worker is *resumed*, its (unchanged) worktree has already been cleaned
up and it lands in the shared checkout — never resume a stopped worktree
agent; spawn a fresh one. Every handoff packet now states the base SHA and the
reset instruction up front.
