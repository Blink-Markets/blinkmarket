# Project workflow

## Stage checkpoints

User preference recorded on 2026-10-03: after completing a coherent stage and
running the relevant verification, commit and push that stage before proceeding.
Do not wait for a separate commit/push request each time, unless the user overrides
this instruction.

- Review the diff and include only in-scope project changes; never include secrets,
  unrelated user edits, or generated artifacts that should remain ignored.
- Update delivery/progress documentation with the completed scope, test results,
  and any remaining verification limitations. Do not label the whole milestone
  complete when only a slice is finished.
- Use a descriptive commit message and push to the established project remote and
  branch. Do not force-push or overwrite remote history. If a push is blocked or
  rejected, report it and preserve the local changes.
- When changing web-consumed shared packages (especially domain/schemas), run
  `pnpm build` as well as `pnpm check` and the service bundle checks. Their source
  exports must reference actual `.ts` files; passing tsx/esbuild tests does not
  prove Turbopack compatibility.
- Confirm the commit hash and whether the push succeeded in the handoff.
- This authorization covers source-control checkpoints only; it does not authorize
  deployment, paid services, signing, or broadcasting blockchain transactions.

## Agent roles and delegation

These rules apply to any coding agent working in this repo, whatever the tool or
model. Pick models by role, not by name: a strong coding model for writing and
judging code, a cheaper fast model for read-only lookups.

- **Controller** (the main session): reads, plans, writes briefs, integrates
  results, verifies, commits and pushes. It does not edit project code or tests
  itself; even a small, clearly specified change goes to an implementer.
- **Explorer**: read-only lookups (find code, read files and docs, survey what
  exists). Use the cheaper model, and run several in parallel when the questions
  are independent.
- **Implementer**: makes the change described in a brief. One implementer per
  independent task; give each its own git worktree when tasks run in parallel.
- **Reviewer**: reviews each implementer's diff against the brief and the plan.
  Use a different agent from the implementer; adversarial review by a second
  model is encouraged for risky or security-relevant changes.

Dispatching:

- Independent work streams may run in parallel without asking each time.
  Dependent tasks run in order.
- A brief states the goal, the files in scope, the constraints, the
  verification commands to run, and what to report back. Point at plan or spec
  files instead of pasting them.
- Tell every agent that internal docs are written in English.
- The controller owns collection: wait for every dispatched agent, read its
  report, and integrate the result before reporting. A dispatched task is not a
  finished task.
- If an agent stops midway (for example on a usage limit), let the same agent
  finish it when possible instead of handing half-done work to another agent;
  meanwhile, keep independent tasks moving.

## Definition of done

A task is done only when all of these hold:

1. New behavior or a bug fix has a test that failed before the change and passes
   after it (TDD: red, green, refactor). Bug fixes address the root cause.
2. The verification for the touched area passes, run with the pinned toolchain
   (Node from `.nvmrc`, pnpm from `packageManager`). Every change runs
   `pnpm check`, except a change whose files all match the `paths-ignore`
   patterns in `.github/workflows/ci.yml`: it may skip `pnpm check`, since CI
   skips such a change too. Report the skip and that reason; the review in
   item 3 still applies. Add the rows for the areas the change touches:

   | Area touched | Commands | CI job |
   | --- | --- | --- |
   | Web app, or a shared package the web consumes | `pnpm build`, `pnpm test:browsers`, `pnpm build:pages && node scripts/check-pages-export.mjs` | check, browsers |
   | API, worker or indexer, or a package they bundle | `pnpm build:services`, then `pnpm test:service-build` | check |
   | Contracts, or code that talks to the chain (deployment, indexer, RFQ relay, signatures, wallets, client and example agents) | `pnpm test:contracts`, `pnpm test:anvil`, `pnpm test:contracts:seeds` | contracts |
   | Migrations, or code that runs against PostgreSQL (adapters, runtime roles and functions, jobs, alerts), and backup and restore | `pnpm test:postgres`, `pnpm drill:restore:test` | postgres |
   | Flows across the API, worker and indexer | `pnpm alpha:local` | alpha-local |
   | Reference agents, or the full market lifecycle (creation, disputes, timeouts, suggestions) | `node --import tsx --test tests/alpha/autonomous.test.ts` (about 18 minutes; needs `TEST_POSTGRES_ADMIN_URL`) | autonomous (nightly, not per push) |
   | Container images or Compose files | `pnpm test:images`, `pnpm images:smoke` | none |

   Report the real output. When a command cannot run on your host (for example
   no Docker, PostgreSQL or Playwright browsers; see `docs/DEVELOPMENT.md` for
   what each command needs), report it as not run, with the reason, and rely
   on its CI job after the push. The autonomous drill runs only nightly: until
   a run after the push passes, report that row as pending. The images row has
   no CI job: run it on a host with Docker, or report the change as unverified.
3. A reviewer has approved the diff with no unresolved Critical or High findings.
   Fixes go back to an implementer and are reviewed again.
4. The controller has read the final diff itself and confirmed it matches the
   brief, with no secrets, debug output or unrelated edits.
5. The stage checkpoint above is done: docs updated, committed, pushed.
6. If the push triggers CI (it touches more than the paths `ci.yml` ignores),
   the CI run for the pushed commit is green. If it fails, fix it in a new
   commit; do not rewrite the pushed one.

## Cleanup

When a task is merged and pushed, remove what it left behind: merged worktrees
and their branches, per-task logs, backup copies, review packages, and any
background wait loops or monitors started for it. Look at a target before
deleting it, and never remove anything a running agent still uses.
