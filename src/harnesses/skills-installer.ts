import { join } from 'node:path';

import { INSTRUCTION_FILES } from '../core/ai-runner.js';
import type { AIPlatform } from '../core/ai-runner.js';
import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';

const SKILLS_DIRS: Record<AIPlatform, string> = {
  claude: '.claude/skills',
  kiro: '.kiro/extensions',
  codex: '.codex/tools',
};

function buildCheckDocsSkill(platform: AIPlatform): string {
  const instructionFile = INSTRUCTION_FILES[platform];

  const platformDocsSection =
    platform === 'claude'
      ? `## Step 2: Find the Right Claude Code Docs Section

The Claude Code documentation index is at:

\`\`\`
https://code.claude.com/docs/llms.txt
\`\`\`

Fetch this first to discover all available pages, then navigate to the section most relevant to your task. The base URL for all docs is \`https://code.claude.com/docs/en/\`.

### If You Are Implementing

| Task type                             | Docs to check                                              |
| ------------------------------------- | ---------------------------------------------------------- |
| Building a new feature                | \`common-workflows.md\` — patterns for everyday coding tasks |
| Working with skills or slash commands | \`skills.md\` — full skills reference                        |
| Delegating to subagents               | \`sub-agents.md\` — how to create and use subagents          |
| Automating around tool events         | \`hooks.md\` and \`hooks-guide.md\`                            |
| Connecting to external tools          | \`mcp.md\` — Model Context Protocol integration              |
| Running Claude programmatically       | \`headless.md\` — Agent SDK usage                            |
| Controlling permissions               | \`permissions.md\` — tool and skill access control           |
| Managing memory and CLAUDE.md         | \`memory.md\` — persistent context across sessions           |

### If You Are Reviewing

| Task type                  | Docs to check                                                  |
| -------------------------- | -------------------------------------------------------------- |
| Security review            | \`security.md\` — safeguards and best practices                  |
| Code quality review        | \`best-practices.md\` — recommended patterns                     |
| Understanding agentic loop | \`how-claude-code-works.md\` — built-in tools and agent behavior |
| Checking permissions model | \`permissions.md\`                                               |

### If You Are Planning or Triaging

| Task type                              | Docs to check                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Choosing the right extension mechanism | \`features-overview.md\` — when to use CLAUDE.md vs Skills vs Subagents vs Hooks vs MCP vs Plugins |
| Coordinating multiple agents           | \`agent-teams.md\`                                                                                 |
| CI/CD integration                      | \`github-actions.md\` or \`gitlab-ci-cd.md\`                                                         |
| Plugin architecture                    | \`plugins.md\` and \`plugins-reference.md\`                                                          |
| Understanding settings                 | \`settings.md\`                                                                                    |

## Quick Reference: Doc Structure

\`\`\`
code.claude.com/docs/en/
├── Getting started
│   ├── quickstart.md          — Install and first steps
│   ├── overview.md            — What Claude Code is
│   └── setup.md               — Installation and auth
├── Using Claude Code
│   ├── common-workflows.md    — Everyday coding patterns
│   ├── best-practices.md      — Tips for quality output
│   ├── interactive-mode.md    — Keyboard shortcuts and modes
│   └── how-claude-code-works.md — Agentic loop internals
├── Extensions
│   ├── skills.md              — Custom slash commands and skills
│   ├── sub-agents.md          — Specialized subagents
│   ├── hooks.md               — Lifecycle hook events
│   ├── mcp.md                 — Model Context Protocol
│   ├── plugins.md             — Packaging extensions
│   └── features-overview.md  — When to use each mechanism
├── Configuration
│   ├── settings.md            — Global and project settings
│   ├── permissions.md         — Access control
│   ├── memory.md              — CLAUDE.md and persistent context
│   └── model-config.md        — Model selection
├── CI/CD Integration
│   ├── github-actions.md
│   ├── gitlab-ci-cd.md
│   └── headless.md            — Agent SDK (programmatic use)
├── Browser
│   └── chrome.md              — Chrome DevTools integration
└── Reference
    ├── cli-reference.md
    ├── security.md
    └── troubleshooting.md
\`\`\``
      : `## Step 2: Check Platform Documentation

Consult your AI platform's official documentation for CLI usage, extension mechanisms, and CI/CD integration patterns. Refer to the platform's docs for the latest features and best practices.`;

  return `---
name: check-docs
description: Always check project docs before implementing, reviewing, or planning. Load at the start of every coding task to find the right docs section for your work type.
---

# Check Documentation First

**Before starting ANY implementation, review, or planning task, you MUST check the relevant documentation.** This keeps you aligned with current APIs, patterns, and conventions — and prevents you from implementing something that already exists or contradicts established architecture.

## Step 1: Check the Project Docs

Start with the local project documentation:

| File                   | Contents                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| \`${instructionFile}\`            | **Read this first.** Critical conventions, build commands, code style, architecture overview, and security constraints. |
| \`docs/architecture.md\` | System architecture, component diagrams, and data flow.                                                                 |
| \`docs/conventions.md\`  | Code conventions, naming rules, and patterns to follow.                                                                 |
| \`docs/layers.md\`       | Architectural layers and dependency rules (what can import what).                                                       |
| \`docs/harness-gaps.md\` | Known gaps and planned improvements to the harness system.                                                              |
| \`harness.config.json\`  | Risk tiers, architectural boundaries, and harness module registry.                                                      |

${platformDocsSection}

## Step 3: Apply What You Found

After reading the relevant docs:

1. **Note any API or pattern changes** since you last worked in this area.
2. **Check if your task is already covered** by a documented workflow or built-in feature.
3. **Identify the architectural layer** your change belongs to (see \`docs/layers.md\` and \`harness.config.json\`).
4. **Verify risk tier** — Tier 3 (critical paths) requires extra test coverage and human review.
5. **Proceed with implementation/review/planning** using the documented patterns.

> **Tip:** Always read \`${instructionFile}\` at the start of every session — it contains the essential conventions and commands for this project.
`;
}

const CHROME_DEVTOOLS_SKILL = `---
name: chrome-devtools
description: Use Chrome DevTools MCP server for browser debugging. Always activate when triaging or planning UI/frontend issues, checking console logs, network requests, visual bugs, or any browser-related problem. Do not skip browser inspection for frontend tasks.
---

# Chrome DevTools MCP — Always Inspect the Browser

When triaging or planning any issue involving UI, frontend, visual bugs, browser behavior, or console errors, you **MUST** use the Chrome DevTools MCP server to inspect the actual browser state before drawing conclusions.

**Never file a triage report or write a plan for a UI/frontend issue without first checking the browser console.**

## Setup

Chrome DevTools MCP connects to your running Chrome or Edge browser via the **Claude in Chrome** browser extension.

- **Enable Chrome integration**: run \`claude --chrome\` or type \`/chrome\` inside a session.
- **Check connection status**: run \`/chrome\` — it shows status and lets you reconnect.
- **MCP server**: \`chrome-devtools-mcp\` (installed via \`npx -y chrome-devtools-mcp@latest\` or through the plugin marketplace).
- **Official docs**: \`https://code.claude.com/docs/en/chrome.md\`
- **MCP server repo**: \`https://github.com/ChromeDevTools/chrome-devtools-mcp\`

## Required Workflow for UI/Frontend Issues

Follow these steps **in order** for any browser-facing problem:

\`\`\`
1. navigate_page   → go to the relevant URL (localhost:PORT or staging URL)
2. list_console_messages  → ALWAYS do this immediately after navigation
3. take_screenshot        → document the visual state
4. list_network_requests  → check for failed API calls (4xx, 5xx, CORS)
5. evaluate_script        → inspect live DOM/JS state if needed
\`\`\`

## All Available Tools (26 total)

### Debugging — Start Here

| Tool                    | What it does                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| \`list_console_messages\` | **Use first.** Lists all console messages: errors, warnings, logs. Errors on page load appear here. |
| \`get_console_message\`   | Get a specific console message by index for detailed inspection.                                    |
| \`evaluate_script\`       | Run any JavaScript in the live page context — inspect variables, call functions, query DOM.         |
| \`take_screenshot\`       | Capture the current visual state of the page. Use to document bugs and verify fixes.                |
| \`take_snapshot\`         | Record the full DOM structure and state for deep inspection.                                        |

### Navigation

| Tool            | What it does                                                              |
| --------------- | ------------------------------------------------------------------------- |
| \`navigate_page\` | Go to a URL. Always call \`list_console_messages\` right after.             |
| \`new_page\`      | Open a new browser tab.                                                   |
| \`list_pages\`    | See all open tabs — useful in multi-tab workflows.                        |
| \`select_page\`   | Switch focus to a specific tab.                                           |
| \`wait_for\`      | Wait for a condition: element visible, network idle, text to appear, etc. |
| \`close_page\`    | Close a tab when done.                                                    |

### Network Inspection

| Tool                    | What it does                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------- |
| \`list_network_requests\` | View all HTTP requests and responses — check for failures, CORS issues, slow calls. |
| \`get_network_request\`   | Get full details (headers, body, timing) for a specific request.                    |

### Interaction (for bug reproduction)

| Tool            | What it does                                               |
| --------------- | ---------------------------------------------------------- |
| \`click\`         | Click an element by selector or coordinates.               |
| \`fill\`          | Type text into an input field.                             |
| \`fill_form\`     | Populate multiple form fields at once.                     |
| \`hover\`         | Hover over an element to trigger hover states or tooltips. |
| \`press_key\`     | Simulate keyboard input (Enter, Tab, Escape, etc.).        |
| \`drag\`          | Drag an element to a new position.                         |
| \`handle_dialog\` | Respond to browser alert/confirm/prompt dialogs.           |
| \`upload_file\`   | Submit a file through a file input element.                |

### Performance

| Tool                          | What it does                                                            |
| ----------------------------- | ----------------------------------------------------------------------- |
| \`performance_start_trace\`     | Begin recording performance metrics.                                    |
| \`performance_stop_trace\`      | Stop recording and get raw trace data.                                  |
| \`performance_analyze_insight\` | Extract Core Web Vitals, bottlenecks, and optimization recommendations. |

### Emulation

| Tool          | What it does                                                                     |
| ------------- | -------------------------------------------------------------------------------- |
| \`emulate\`     | Simulate different devices (mobile, tablet) or network conditions (3G, offline). |
| \`resize_page\` | Change the viewport size for responsive testing.                                 |

## Example Workflows

### Triaging a Console Error

\`\`\`
1. navigate_page({ url: "http://localhost:3000/broken-page" })
2. list_console_messages()          ← copy errors into your triage report
3. take_screenshot()                ← attach as visual evidence
4. list_network_requests()          ← check if any API call failed
5. evaluate_script({
     expression: "window.__lastError || document.querySelector('.error')?.textContent"
   })                               ← inspect live state
\`\`\`

### Reproducing a Form Validation Bug

\`\`\`
1. navigate_page({ url: "http://localhost:3000/login" })
2. list_console_messages()          ← baseline: any errors on load?
3. fill({ selector: "#email", value: "bad@" })
4. fill({ selector: "#password", value: "x" })
5. click({ selector: "[type=submit]" })
6. wait_for({ condition: "network-idle" })
7. list_console_messages()          ← what happened after submit?
8. take_screenshot()                ← document the result
\`\`\`

### Investigating a Slow Page

\`\`\`
1. navigate_page({ url: "http://localhost:3000/dashboard" })
2. performance_start_trace()
3. wait_for({ condition: "network-idle" })
4. performance_stop_trace()
5. performance_analyze_insight()    ← get LCP, INP, CLS, bottlenecks
6. list_network_requests()          ← find slow API calls
\`\`\`

### Mobile/Responsive Testing

\`\`\`
1. emulate({ device: "iPhone 14" })
2. navigate_page({ url: "http://localhost:3000" })
3. take_screenshot()                ← check mobile layout
4. list_console_messages()          ← mobile-specific errors?
\`\`\`

## What to Include in Your Triage/Plan Output

When you use Chrome DevTools for a triage or planning task, include in your output:

- **Console errors**: paste the exact error messages from \`list_console_messages\`
- **Screenshot**: reference the captured screenshot as visual evidence
- **Network failures**: list any failed requests (status, URL, error)
- **Reproduction steps**: the exact sequence of browser interactions that triggers the bug
- **Browser state**: any relevant DOM or JS state from \`evaluate_script\`

## Important Notes

- **Always run \`list_console_messages\` immediately after \`navigate_page\`** — many errors only appear on page load.
- If Chrome is not connected, run \`/chrome\` to reconnect or start with \`claude --chrome\`.
- Chrome DevTools MCP works with Google Chrome and Microsoft Edge (not Brave, Arc, or other Chromium variants).
- WSL (Windows Subsystem for Linux) is not supported for Chrome integration.
- For more detail on the chrome integration, see: \`https://code.claude.com/docs/en/chrome.md\`
`;

function getSkills(platform: AIPlatform): Array<{ name: string; content: string }> {
  const skills: Array<{ name: string; content: string }> = [
    { name: 'check-docs', content: buildCheckDocsSkill(platform) },
  ];

  // Chrome DevTools skill is Claude-specific (uses /chrome command, claude --chrome flag)
  if (platform === 'claude') {
    skills.push({ name: 'chrome-devtools', content: CHROME_DEVTOOLS_SKILL });
  }

  return skills;
}

export const skillsInstallerHarness: HarnessModule = {
  name: 'skills-installer',
  displayName: 'Skills Installer',
  description: 'Installs agent skills/extensions into the platform-specific directory',
  order: 17,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const { repoRoot, fileWriter } = ctx;
    const filesCreated: string[] = [];
    const filesModified: string[] = [];
    const skillsDir = SKILLS_DIRS[ctx.runner.platform];

    const snap = fileWriter.snapshot();
    const skills = getSkills(ctx.runner.platform);

    for (const skill of skills) {
      const destPath = join(repoRoot, skillsDir, skill.name, 'SKILL.md');
      await fileWriter.write(destPath, skill.content);
    }

    const diff = fileWriter.diffSince(snap);
    filesCreated.push(...diff.created);
    filesModified.push(...diff.modified);

    const output: HarnessOutput = {
      harnessName: 'skills-installer',
      filesCreated,
      filesModified,
      metadata: { skillsInstalled: skills.map((s) => s.name) },
    };
    ctx.previousOutputs.set('skills-installer', output);
    return output;
  },
};
