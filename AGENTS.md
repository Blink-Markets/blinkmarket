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
