# verify.template.mjs — TODO markers

This template is the scaffolding for a single browser-verify run. The agent copies it to
`<cwd>/.harnext/browser-verify/<run-id>/scenario.mjs` and fills in three marker blocks:

1. **`TODO(model): STARTING_URL`** — the `page.goto(...)` target.
2. **`TODO(model): REPRO_STEPS`** — one `step('label', async () => {...}, { page, runDir: RUN_DIR })`
   call per user-visible action. The `step()` helper writes `steps.jsonl` and captures an
   accessibility snapshot on failure.
3. **`TODO(model): ASSERTIONS`** — `throw` from within a final `step()` call when an
   expected condition doesn't hold. This marks the run as failed and triggers the snapshot.

Everything else — launching the user's Chromium-based browser against their profile,
attaching console/network/pageerror listeners, recording the video, redacting the HAR,
writing `summary.json`, stopping the Playwright trace — is pre-wired and should not be
edited.

The scenario is invoked by:

```
SKILL_DIR=<abs-path-to-skill-dir> \
RUN_DIR=<run-dir> \
USER_DATA_DIR=<from profile-lock.mjs> \
EXECUTABLE_PATH=<from detect-browser.mjs> \
RUN_ID=<from new-run.mjs> \
MODE=reproduce|verify \
HEADLESS=0 TIMEOUT_MS=30000 \
node <run-dir>/scenario.mjs
```

Exit 0 = passed, exit 1 = failed.
