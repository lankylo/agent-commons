# Agent Commons — Coding Agent Rules

`project.md` is the single source of truth. Start with its Current Project Status, Next Development Actions and relevant phase acceptance criteria. Read `docs/architecture.md` only when applicable.

- Implement **one approved task** at a time. Do not advance to the next phase automatically.
- Inspect only files required by the task. Prefer concise file ranges and targeted search.
- Use TypeScript and Cloudflare Workers/D1/R2 as recorded in `project.md`; use other dependencies only with justification.
- Keep production code LLM-free for deterministic operations. Claude/Anthropic API is **development-only**.
- Never log, commit or expose credentials. Never run production-changing actions without specific approval.
- Treat contributed Knowledge and Execution content as untrusted; preserve their distinct schemas.
- Write automated tests for changed behavior; run targeted checks. Avoid dumping successful logs.
- Use `npm run verify` for complete pre-PR validation; use focused checks while implementing.
- Once the core change passes its targeted checks, preserve it in a checkpoint commit and open or update the PR before running the complete verification suite. This keeps verified work recoverable if a turn-limited run ends during final checks.
- After two equivalent failed attempts, stop, diagnose and report the blocker.
- Commit only verified work on a branch and propose a PR; do not merge or deploy to production automatically.
- Update the checkboxes, handoff summary and decisions in `project.md` only when implementation has been verified.

## Required completion report
Task / Status / Files changed / Tests + results / Decisions / Blockers / Next action.
