---
name: report-harnext-issue
description: File a GitHub issue against the harnext repo (QualityUnit/harnext) from within harnext, enriched with non-sensitive environment context. Uses a fallback chain (authenticated gh → GitHub REST API with a token → zero-auth prefilled issue URL) so reporting works even without gh installed or authenticated. Reserved for the /report-harnext-issue command.
disable-model-invocation: true
---

# report-harnext-issue

File a well-formed issue against **`QualityUnit/harnext`** from the user's free-text report (the `User:` message below). The goal is that reporting *almost never fails*: walk a fallback chain from the lowest-friction authenticated path down to a zero-credential prefilled URL, and always leave the user with a usable next step.

The target repo is hard-coded to `QualityUnit/harnext` for v1.

## Steps

1. **Read the report.** The user's description is the `User:` text appended to this prompt. If it is empty, stop and print `Usage: /report-harnext-issue <description>` — but normally the command already guards this, so you can assume a description is present.

2. **Gather non-sensitive context** with the `bash` tool. Collect only what helps a maintainer reproduce — **never** include secrets, API keys, tokens, or `.env` contents:
   - harnext version: `harnext --version` (fall back to "unknown" if it errors).
   - OS / platform: `uname -srm` (or note the platform if it fails).
   - Node version: `node --version`.

3. **Draft the issue.**
   - **Title:** a concise, specific one-line summary derived from the report (not the raw description verbatim if it is long).
   - **Body:** Markdown with the user's description first, then a `## Environment` section listing harnext version, OS/platform, and Node version. Add a short footer noting it was filed via `/report-harnext-issue`. Do not invent details the user did not provide.

4. **Execute the fallback chain — stop at the first tier that succeeds.**

   **Tier 1 — authenticated `gh` CLI (preferred).**
   - Check availability: `gh auth status` (and `gh --version`). If `gh` is installed *and* authenticated, create the issue:
     ```
     gh issue create --repo QualityUnit/harnext --title "<title>" --body "<body>"
     ```
   - On success, `gh` prints the new issue URL. Report it and stop.
   - If `gh` is missing or unauthenticated, or the command fails, fall through to Tier 2.

   **Tier 2 — GitHub REST API with a token.**
   - Look for a token in `GITHUB_TOKEN` or `GH_TOKEN` (`bash`: `printenv GITHUB_TOKEN`, `printenv GH_TOKEN`). Do **not** print the token's value.
   - If a token is present, POST to the issues endpoint. Write the JSON payload to a temp file (avoids shell-quoting issues with multi-line bodies) and reference the token via the env var so it never appears in the command text or logs:
     ```
     # build /tmp/harnext-issue.json with {"title": "...", "body": "..."} using your tools
     curl -sS -X POST \
       -H "Authorization: Bearer $GITHUB_TOKEN" \
       -H "Accept: application/vnd.github+json" \
       -H "X-GitHub-Api-Version: 2022-11-28" \
       https://api.github.com/repos/QualityUnit/harnext/issues \
       -d @/tmp/harnext-issue.json
     ```
     (Use `$GH_TOKEN` if that is the one that is set.)
   - On success the response JSON contains `html_url` — report it and stop. Remove the temp file afterward.
   - If no token is present, or the request fails (non-2xx), fall through to Tier 3.

   **Tier 3 — zero-auth prefilled URL (always available).**
   - Construct a prefilled "new issue" link so the user can file with one click, no credentials needed:
     ```
     https://github.com/QualityUnit/harnext/issues/new?title=<urlencoded-title>&body=<urlencoded-body>
     ```
   - URL-encode both the title and the body (encode spaces, newlines, `#`, `&`, etc.). A reliable way:
     ```
     node -e 'const t=process.argv[1],b=process.argv[2];console.log("https://github.com/QualityUnit/harnext/issues/new?title="+encodeURIComponent(t)+"&body="+encodeURIComponent(b))' "<title>" "<body>"
     ```
   - Print the URL and tell the user to open it in a browser to finish filing. This tier never hard-fails.

5. **Report the outcome clearly**, naming which tier was used:
   - Tier 1/2: `Filed: <issue-url>` (mention created issue number if known).
   - Tier 3: `Couldn't file automatically (no GitHub auth available). Open this URL to finish filing:` followed by the URL.

## Guardrails

- **Never include secrets.** No API keys, tokens, auth.json contents, or `.env` values in the title or body. Reference tokens only via env vars; never echo their values.
- **Hard-code the repo** to `QualityUnit/harnext` for v1.
- **Always end with an actionable result** — a created issue URL or a prefilled URL. Degrade gracefully tier by tier; never leave the user with just an error.
- **Don't over-collect.** Version, OS, and Node version are enough environment context. Don't dump full environment, process lists, or file trees.
