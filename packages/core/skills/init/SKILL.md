---
name: init
description: Detect the repo's tech stack (including monorepo sub-apps) and scaffold a project-local `setup` skill at `<cwd>/.harnext/skills/setup/` that lets future harnext sessions install dependencies, run each runnable app in the background, and attach to their logs. Use when bootstrapping a new repo.
---

# init

Create a project-local `setup` skill that records how to install dependencies, run each runnable app in this repo, and attach to its logs from future sessions. For monorepos, cover every runnable sub-app.

## Steps

1. **Survey the repo and enumerate runnable apps.**
   - Use `bash` (`ls`, `git status`, `find`) and `read`. Detect the workspace style:
     - Polyrepo — single package manager at the root.
     - Monorepo — npm/yarn/pnpm workspaces (`workspaces` in root `package.json`, `pnpm-workspace.yaml`), Turborepo/Nx/Lerna (`turbo.json`, `nx.json`, `lerna.json`), Go multi-module, Python Poetry monorepos, Cargo workspaces (`[workspace]` in root `Cargo.toml`), Bazel, etc.
   - For each package/module, look for a runnable entry: `scripts.dev` / `scripts.start` in `package.json`, a `main.py` / `manage.py`, a binary target, a `Dockerfile`. Skip libraries with no dev target.
   - Build a list `apps = [{ name, path, runCmd, buildCmd, testCmd, envFile }]`. `name` should be a short slug unique within the repo (e.g., `api`, `web`, `worker`).

2. **Identify canonical commands.** Pull install, build, test, and per-app dev/start commands from manifests, CI configs, and READMEs. **Never guess.** If a command isn't discoverable, omit it.

3. **Scaffold `<cwd>/.harnext/skills/setup/`.** Using `bash mkdir -p` and `write`:

   a. Write `<cwd>/.harnext/skills/setup/SKILL.md`. Frontmatter:

      ```
      ---
      name: setup
      description: Install dependencies, run each app in this repo in the background, and tail its logs. Produced by /init — documents the detected tech stack and canonical commands.
      ---
      ```

      Body (omit any section with no discoverable command):
      - **Stack** — primary language(s), package manager, monorepo tool, service dependencies (Docker, Postgres, etc.).
      - **Prerequisites** — toolchain versions from `.tool-versions`, `engines`, `python_requires`.
      - **Install** — the exact command.
      - **Build** — the exact command (or per-app if there's no root build).
      - **Test** — the exact command.
      - **Apps** — one subsection per runnable app with:
        - **Path:** repo-relative path to the app directory.
        - **Start (background):** `bash <skill-dir>/start-<name>.sh` — streams logs to `.harnext/logs/<name>.log`.
        - **Tail logs:** `bash <skill-dir>/tail-<name>.sh` — follows that log file.
        - **Stop:** `bash <skill-dir>/stop-<name>.sh` — kills the PID recorded in `.harnext/logs/<name>.pid`.
        - **Env:** list required variables by name only; point at `.env.example`.
      - **Lint / Typecheck** — if present.

      Cite the source file for each command in parentheses (e.g., `npm install  (package.json scripts)`).

   b. For **each runnable app**, write three helper scripts next to `SKILL.md`. Replace the `<...>` placeholders with real values; `<APP-PATH>` is relative to the repo root. Logs always land at `<repo-root>/.harnext/logs/<name>.log`.

      **How the subprocess/log model works (and why you must follow the template).** The agent's `bash` tool runs commands through a short-lived shell and returns when that shell closes its stdio. To launch a long-lived app without blocking the agent:
      - The app **must** run detached from the shell: `nohup <cmd> >> <logfile> 2>&1 &`. The `&` backgrounds it, `nohup` protects it from SIGHUP when the shell exits, and the redirect disconnects its fd1/fd2 from the shell's pipes so the shell can close immediately.
      - Because the child writes to a file on disk, a later `bash` call — in this session or any future session — can read it directly with `cat`, `tail -n N`, `grep`, etc. The agent's access to logs does not depend on the original launching process; it only depends on the file path.
      - **Do not use `tail -f` from the agent.** It blocks until the tail process is killed and will stall the agent's bash call. For the agent, use bounded snapshots (`tail -n 200 <logfile>`, `grep … <logfile>`). The `tail-<name>.sh` script is for humans running it in a real terminal.

      `start-<name>.sh`:
      ```bash
      #!/usr/bin/env bash
      set -euo pipefail
      ROOT="$(git rev-parse --show-toplevel)"
      mkdir -p "$ROOT/.harnext/logs"
      cd "$ROOT/<APP-PATH>"
      nohup <RUN-CMD> >> "$ROOT/.harnext/logs/<NAME>.log" 2>&1 &
      echo $! > "$ROOT/.harnext/logs/<NAME>.pid"
      echo "started <NAME> (pid=$(cat "$ROOT/.harnext/logs/<NAME>.pid")) — log: .harnext/logs/<NAME>.log"
      ```

      `tail-<name>.sh`:
      ```bash
      #!/usr/bin/env bash
      set -euo pipefail
      ROOT="$(git rev-parse --show-toplevel)"
      exec tail -n 200 -f "$ROOT/.harnext/logs/<NAME>.log"
      ```

      `stop-<name>.sh`:
      ```bash
      #!/usr/bin/env bash
      set -euo pipefail
      ROOT="$(git rev-parse --show-toplevel)"
      PID_FILE="$ROOT/.harnext/logs/<NAME>.pid"
      [ -f "$PID_FILE" ] || { echo "no pid file for <NAME>"; exit 0; }
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "stopped <NAME>"
      ```

      After writing, `bash chmod +x <paths>`. Reference scripts in SKILL.md using the skill-dir-relative paths (e.g., `setup/start-api.sh`).

   c. **Gitignore the log dir.** Read `<cwd>/.gitignore`; if `.harnext/logs/` isn't covered, append:

      ```
      # harnext: runtime log capture from setup skill
      .harnext/logs/
      ```

      If `.gitignore` doesn't exist, create it with just that block.

4. **Verify each generated script before finalizing.** For every app, prove the scripts actually work — don't ship broken scaffolding. Do this sequentially per app (concurrent starts can fight over ports). For each app:

   a. `bash <cwd>/.harnext/skills/setup/start-<name>.sh`. The agent's bash call should return within a second (the shell exits; the app runs detached). If it hangs more than ~5s, the script isn't detaching properly — fix the redirection.
   b. `bash sleep 3` (or `sleep 5` for apps with slow boot like webpack/vite).
   c. `bash test -s "<cwd>/.harnext/logs/<name>.log" && echo OK || echo EMPTY` — confirms the log has at least some content.
   d. `bash tail -n 50 "<cwd>/.harnext/logs/<name>.log"` — read a snapshot. Scan for obvious boot errors (`Error`, `EADDRINUSE`, `ModuleNotFoundError`, non-zero exit notices).
   e. `bash <cwd>/.harnext/skills/setup/stop-<name>.sh` — always stop, even if verification failed, so the next app isn't blocked on the same port.

   If an app fails verification (empty log, obvious error in snapshot, or stop script can't find the PID): keep the scripts (they're still useful as a starting point), note the failure in the summary, and suggest the likely fix (missing env var, DB not running, port in use) based on what appeared in the log. Do **not** retry with modified commands unless the user asks — getting the real command right is the user's call.

5. **Summarize.** Print a short report: detected stack, enumerated apps, files created, and the verification result per app (pass / fail + one-line reason). Tell the user to restart harnext so `/skill:setup` picks up the new skill — from then on, any session can call `bash <skill-dir>/start-<name>.sh` to launch an app detached and read `.harnext/logs/<name>.log` for its output.

## Guardrails

- **Run nothing except the verification pass.** Don't run install / build / test / manual dev commands during init. The only commands you execute are the `start-<name>.sh` / `stop-<name>.sh` scripts you just wrote, in Step 4, strictly to verify them.
- **Don't clobber existing scaffolding.** If `<cwd>/.harnext/skills/setup/` already exists, diff against the current contents and only rewrite entries whose `<RUN-CMD>` / `<APP-PATH>` have changed. Preserve handwritten notes in SKILL.md.
- **Skip non-runnable packages.** Pure libraries get a mention under **Stack**, not start/tail/stop scripts.
- **No secrets.** Never inline `.env` values; reference `.env.example` by path.
- **Unique names.** If two apps would collide (e.g., two `api` packages), prefix with the package path (`api-core`, `api-web`).
- **Project-local only.** All writes go under `<cwd>/.harnext/`, never `~/.harnext/`.
- **Keep SKILL.md under ~120 lines** even for monorepos with many apps; link to scripts instead of inlining long commands.
