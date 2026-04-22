---
name: review
description: Review the diff between the current branch and its merge base against main (or master). Flag bugs, regressions, missing tests, and style deviations. Use when the user asks to review the current branch or a pending change.
---

# review

Review the pending changes on the current branch.

## Steps

1. `bash`: `git rev-parse --abbrev-ref HEAD`; detect base branch (prefer `main`, fall back to `master`).
2. `bash`: `git merge-base HEAD <base>`, then `git diff <merge-base>...HEAD --stat` and `git diff <merge-base>...HEAD`.
3. `read` each changed file at HEAD — diff alone misses surrounding context.
4. Per file, call out: correctness bugs, missing error handling, missing/weak tests, violated project conventions (cross-reference siblings).
5. Summarize as **Must fix / Should fix / Nits** with `file:line` citations.

## Guardrails

- Review is read-only. Never edit files.
- If the diff is empty or `main` isn't a shared ancestor, stop and report that instead of guessing.
