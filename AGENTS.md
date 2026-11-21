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
2. The verification for the touched area passes, at minimum `pnpm check`. Add
   `pnpm build` and the service bundle checks for web-consumed shared packages
   (see Stage checkpoints), and the relevant suites from `docs/DEVELOPMENT.md`
   (contracts, Postgres, Anvil, browsers) when that area changed. Report the
   real output; a skipped suite is reported as skipped, with the reason.
3. A reviewer has approved the diff with no unresolved Critical or High findings.
   Fixes go back to an implementer and are reviewed again.
4. The controller has read the final diff itself and confirmed it matches the
   brief, with no secrets, debug output or unrelated edits.
5. The stage checkpoint above is done: docs updated, committed, pushed.

## Cleanup

When a task is merged and pushed, remove what it left behind: merged worktrees
and their branches, per-task logs, backup copies, review packages, and any
background wait loops or monitors started for it. Look at a target before
deleting it, and never remove anything a running agent still uses.
