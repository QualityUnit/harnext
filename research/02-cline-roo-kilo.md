# Multi-Model Usage & Cost Savings in Cline, Roo Code, and Kilo Code

> Research focus: how three VS Code AI coding agents (Cline, Roo Code, Kilo Code) let users
> assign **different models to different modes/tasks** and the surrounding cost-optimization
> machinery (prompt caching, context condensing, checkpoints, OpenRouter routing, cost tracking,
> diff edits). Compiled from primary sources (vendor docs, GitHub, vendor blogs). Date: 2026-06-17.

Lineage note: Roo Code is a fork of Cline; Kilo Code is a fork/merge descendant of both Roo and
Cline (and shares config concepts with OpenCode — note the `.opencode/` fallback path). So many
primitives (modes, diff edits, checkpoints, `.clinerules` compatibility) recur across all three,
with each successive fork generalizing the model-per-mode idea further.

---

## 1. Plan vs Act (Cline) and Modes (Roo / Kilo) — per-mode model assignment

### 1.1 Cline — Plan & Act

Cline has exactly **two modes**, toggled with a switch in the chat box:

- **Plan mode** — read-only. "Cline can read code and discuss strategy but cannot modify files or
  run commands." Used to explore/strategize before touching anything.
- **Act mode** — full execution; retains the planning context and can edit files / run commands.

**Per-mode model assignment** is a first-class, explicitly designed feature:

1. Open Cline Settings.
2. Enable **"Use different models for Plan and Act"**.
3. Select a preferred model for each mode.

"Switching between Plan and Act mode automatically switches to the configured model for that mode,"
and your selection is preserved when you switch back. The intended pattern is a **stronger reasoning
model for planning and a faster/cheaper model for implementation**.

There is also a `/deep-planning` slash command that triggers an extended planning session (systematic
codebase exploration + detailed implementation plan) before switching to Act.

Sources:
- https://docs.cline.bot/core-workflows/plan-and-act
- https://deepwiki.com/cline/cline/3.4-plan-and-act-modes

> Caveat: there are tracked bugs where Plan/Act model selection unexpectedly syncs or reverts despite
> the checkbox (cline/cline issues #4187, #2501). So the feature works but has had reliability edges.

### 1.2 Roo Code — five built-in modes, model is "sticky" per mode

Roo ships five built-in modes, each with **different tool-group restrictions** (this is the real
safety/cost lever — a planning mode physically can't burn tokens writing files):

| Mode | Role | Tool access |
|------|------|-------------|
| 💻 **Code** (default) | Implement features, write/debug code | Full: `read`, `edit`, `command`, `mcp` |
| ❓ **Ask** | Explain code, answer questions | `read`, `mcp` only — no edits, no commands |
| 🏗️ **Architect** | System design, implementation planning | `read`, `mcp`, `edit` **markdown only** |
| 🪲 **Debug** | Systematic diagnosis | Full: `read`, `edit`, `command`, `mcp` |
| 🪃 **Orchestrator** | Decompose & delegate (see §5) | No direct tools; uses `new_task` to delegate |

**Model assignment:** Roo does **not** pin a model directly on the mode object. Instead each mode is
linked to an **API Configuration Profile** (§3), and Roo uses **"Sticky Models"**: "Each mode
remembers your last-used model. When switching modes, Roo automatically selects that model." You can
also explicitly associate a profile with a mode in the Prompts tab; the system remembers the
last-used profile per mode.

Sources:
- https://docs.roocode.com/basic-usage/using-modes  (→ https://roocodeinc.github.io/Roo-Code/basic-usage/using-modes)
- https://docs.roocode.com/features/custom-modes

### 1.3 Kilo Code — agents pin a model directly

Kilo calls modes **"agents"** and ships seven built-ins: `code`, `plan`, `debug`, `ask`,
`orchestrator`, `explore`, `general`. Unlike Roo, a Kilo agent can **pin a model directly** in its
config with a `model: "provider/model"` field (plus `temperature`, `permission`, `steps`, etc.).
The model selector also remembers the last model per agent across sessions; config-pinned models act
as defaults.

Source: https://kilo.ai/docs/customize/custom-modes

---

## 2. Cheap-for-planning / expensive-for-coding pairings (and the real-world data)

### 2.1 Cline's recommended pairings (from the docs)

| Strategy | Plan mode | Act mode |
|----------|-----------|----------|
| Cost optimization | GLM 4.6 | Grok Code Fast |
| Maximum quality | Claude Opus | Claude Sonnet |
| Speed-focused | Gemini 3 Flash | Cerebras |

Source: https://docs.cline.bot/core-workflows/plan-and-act

### 2.2 What users actually do (Cline telemetry blog)

Cline published aggregate usage of Plan/Act model choices:

- **Plan mode:** Claude Sonnet 4 = 42.6%, Gemini 2.5 Pro = 15.3%.
- **Act mode:** Claude Sonnet 4 = 46.6% (even more dominant).
- **Most popular cross-mode pair:** **Claude Opus 4.1 (Plan) → Claude Sonnet 4 (Act)** = 25.3% of all
  cross-mode usage. This is the canonical "expensive reasoning model plans, cheaper-but-strong model
  executes" pattern.

Pricing context the blog used (per 1M tokens):
- Sonnet 4/4.5: $3 in / $15 out
- Opus 4.1: $15 in / $75 out
- Gemini 2.5 Pro: $1.25 in / $10 out; Gemini 2.5 Flash: $0.30 in / $2.50 out
- DeepSeek Chat v3: $0.24 in / $0.84 out

Notable finding: most users still pick Sonnet over much cheaper Gemini Flash / DeepSeek — they
prioritize execution quality over raw token price. The savings come mostly from the **Opus→Sonnet
downgrade between phases**, not from going to a budget provider.

Sources:
- https://cline.bot/blog/plan-act-model-usage-patterns-in-cline

### 2.3 Roo / Kilo recommended pairings

Roo docs/community example: **o3 for Architect planning, Claude Sonnet 4 for Code execution**. Roo
also recommends per-mode **temperature** tuning (a cheap, model-agnostic quality lever):

- Code: 0.0–0.3 (deterministic) · Architect: 0.4–0.7 · Ask: 0.7–1.0 · Debug: 0.0–0.3

Kilo's framing: "use a supercomputer to run a calculator app" is the anti-pattern — simple tasks
(validation, formatting) should run on budget models; reserve premium models for architecture/complex
reasoning. Its `model` field per agent makes this explicit.

Sources:
- https://www.thisdot.co/blog/roo-custom-modes
- https://docs.roocode.com/basic-usage/using-modes
- https://dev.to/kilocode/... (Kilo credit-system writeups)

---

## 3. API / Configuration Profiles — switching provider+model per mode/task

### 3.1 Roo Code "API Configuration Profiles" (the cleanest design)

A **profile** bundles everything needed to talk to a model, so switching profile = switching
provider+model+params atomically:

Configurable fields per profile:
- **API Provider** (OpenAI, Anthropic, OpenRouter, …)
- **API Key** (stored in VS Code Secret Storage, never plaintext)
- **Model** (e.g. `o3-mini-high`, Claude 3.7 Sonnet, DeepSeek R1)
- **Temperature**
- **Thinking Budget** (provider-specific)
- **Rate Limit** (min seconds between requests; default 0)
- **Diff Editing config** (provider-specific edit behavior)

Creating: Settings → Providers → "+" → name it → fill fields.

Switching: profile dropdown in Settings, **or** an API Configuration dropdown inside the chat — so
you can change provider mid-task.

**Stickiness rules (important for cost):**
- Profiles are linked to modes in the Prompts tab; the system remembers last-used profile per mode.
- Profiles are **sticky to a task** — resuming task history reuses the original profile; switching
  profiles in another window doesn't affect existing tasks.
- **Orchestrator subtasks inherit the parent's profile** by default (so delegation doesn't silently
  re-price).

Source: https://docs.roocode.com/features/api-configuration-profiles
(→ https://roocodeinc.github.io/Roo-Code/features/api-configuration-profiles)

### 3.2 Kilo Code config (file-based, declarative)

Kilo supports the same idea but as **declarative config files** with precedence merging. Three
authoring methods:

**(a) Markdown + YAML frontmatter** in `.kilo/agents/`:
```yaml
---
description: Specialized for writing technical documentation
mode: primary            # primary | subagent | all
model: anthropic/claude-sonnet-4-20250514
color: "#10B981"
permission:
  edit:
    "*.md": "allow"
    "*": "deny"
  bash: deny
---
You are a technical documentation specialist...
```

**(b) `kilo.jsonc`:**
```jsonc
{
  "agent": {
    "docs-writer": {
      "description": "Writing and editing technical documentation",
      "mode": "primary",
      "model": "anthropic/claude-sonnet-4-20250514",
      "temperature": 0.3,
      "permission": { "edit": { "*.md": "allow", "*": "deny" }, "bash": "deny" }
    }
  }
}
```

**Overriding a built-in agent** (e.g. make `code` cheap by default):
```jsonc
{ "agent": { "code": { "model": "openai/gpt-4o", "temperature": 0.2 } } }
```

**Config precedence (low→high):** built-in defaults → global `~/.config/kilo/kilo.jsonc` →
project `kilo.jsonc` → `.kilo/` / `.opencode/` files → `KILO_CONFIG_CONTENT` env var. Properties
**merge** across levels (partial overrides allowed). Org-managed modes outrank personal config.

Source: https://kilo.ai/docs/customize/custom-modes

---

## 4. Context management & cost: caching, condensing, checkpoints

### 4.1 Prompt caching

- **Cline** maximizes prompt caching to cut cost. Its truncation strategy deliberately **removes file
  redundancy first** to keep the cache prefix stable and **maximize cache hits**. v3.14 added improved
  Gemini caching. Through **OpenRouter**, caching is passed through to underlying models that support
  it.
- General principle across all three: keep the prompt prefix stable so providers can cache it; that's
  why mode/system-prompt churn is expensive.

Sources:
- https://cline.bot/blog/inside-clines-framework-for-optimizing-context-maintaining-narrative-integrity-and-enabling-smarter-ai
- https://cline.bot/blog/cline-v3-14-improved-gemini-caching-newrule-command-enhanced-checkpoints-key-updates
- https://deepwiki.com/cline/cline/4.5-advanced-provider-features

### 4.2 Context condensing / summarization

**Cline — "Auto Compact"** (also `/compact`, `/smol`): when the conversation nears the context
window, Cline auto-summarizes it in-place, preserving technical details/code/decisions. **Cost is
low because it reuses the existing prompt cache** — most input tokens are already cached, so you
mainly pay for the summary's *output* tokens. You can roll back via checkpoints to before a
summarization. Cline also lazy-loads MCP docs (a `load_mcp_documentation` tool pulling ~8k tokens
only on demand) instead of baking them into every system prompt.

Sources:
- https://docs.cline.bot/features/auto-compact
- https://cline.bot/blog/how-to-think-about-context-engineering-in-cline

**Roo — "Intelligent Context Condensing"**: an AI call summarizes older history when
`usagePercentage >= condensationThreshold` (percentage slider, **default 100%**, lowerable e.g. to
80% to trigger earlier; manual trigger also available). The condense prompt is overridable via
`customSupportPrompts.CONDENSE`.

> **Key design decision relevant to a harness:** Roo does **NOT** let a cheaper/separate model do the
> summarization. "Condensing always uses your active conversation provider/model." Rationale: the
> history contains tool calls / tool results / structured content, and a different model risks
> **translation errors between tool-format expectations**. The summarization cost is surfaced in the
> UI (a `ContextCondenseRow` shows before/after token counts + the cost of the condensing call — an
> audit trail).

Sources:
- https://docs.roocode.com/features/intelligent-context-condensing
  (→ https://roocodeinc.github.io/Roo-Code/features/intelligent-context-condensing)

> Takeaway tension: **Cline reuses cache to make condensing cheap; Roo refuses to swap to a cheap model
> for condensing to avoid tool-format corruption.** Both point to the same lesson: summarization with
> a *different* model is risky/often not worth it once tool-call content is in the transcript.

### 4.3 Checkpoints

All three (Cline-lineage) save **state checkpoints** during agentic runs so you can roll back to any
point — including to *before* a context summarization, so context is never truly lost. Every edit is
shown as a reviewable/revertible diff and tied to a checkpoint. (Not a direct cost feature, but it
lets users use aggressive auto-approve + cheap models safely, recovering from bad cheap-model output
without re-paying for a full task.)

Sources:
- https://cline.bot/ ; https://github.com/cline/cline
- https://cline.bot/blog/cline-v3-14-...

---

## 5. Roo custom modes + Orchestrator / Boomerang Tasks (subtask delegation to different models)

### 5.1 Custom modes (Roo)

Defined in `custom_modes.yaml`/`.json` (global) or `.roomodes` (project). Properties: `slug`,
`name`, `description`, `roleDefinition`, `whenToUse`, `customInstructions`, `groups` (tool access +
`fileRegex` file restrictions). Example:

```yaml
customModes:
  - slug: docs-writer
    name: 📝 Documentation Writer
    description: Specialized for technical documentation writing
    roleDefinition: >-
      You are a technical writer specializing in clear, comprehensive documentation.
    whenToUse: Use this mode for documentation creation and editing tasks
    customInstructions: |-
      - Maintain consistent terminology
      - Use active voice
    groups:
      - read
      - - edit
        - fileRegex: \.(md|mdx)$
          description: Markdown files only
```

Crucially, **a custom mode does not name a model** — the model comes from the associated **API
Configuration Profile** (+ sticky-model memory). `whenToUse` is consumed by orchestration tools (not
shown in UI) to decide automated delegation.

Source: https://docs.roocode.com/features/custom-modes

### 5.2 Orchestrator / Boomerang Tasks (the multi-model delegation engine)

The 🪃 **Orchestrator** mode decomposes a complex task and **delegates subtasks to specialist modes**
via the `new_task` tool. Because each mode carries its own profile/model, **each subtask effectively
runs on the model best (and cheapest) suited to it.**

Flow:
1. Orchestrator analyzes the task, proposes subtasks.
2. Parent **pauses**; subtask launches in the chosen specialist mode (Code/Architect/Debug/…).
3. Subtask runs in an **isolated context** (separate conversation history).
4. On completion, **only a summary returns** to the parent ("this summary will be the source of
   truth"); parent resumes. Results chain from subtask to subtask.

Cost-relevant properties:
- **Context isolation** keeps the parent's (expensive-model) context small and clean → fewer tokens,
  better caching, less context poisoning.
- **Orchestrator itself has no read/write/MCP/command tools** — it only orchestrates, so the
  coordinator role stays cheap and focused.
- By default subtasks **inherit the parent profile**, but assigning each specialist mode its own
  profile is exactly how you get cheap-coder / expensive-architect splits inside one workflow.

Sources:
- https://docs.roocode.com/features/boomerang-tasks
  (→ https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks)
- https://deepwiki.com/.../2.1-orchestrator-mode

Kilo mirrors this with its `orchestrator` agent + `mode: subagent` agents (agent-invocable only) and
a `task` permission, so org-managed subagents can be pinned to specific cheap models.

---

## 6. Automatic model routing, OpenRouter, cost tracking / telemetry

### 6.1 Kilo "Auto Model" — automatic routing (the standout feature)

A smart router that "selects an underlying model for each request," with **three tiers**:

- **Frontier** — premium; routes reasoning-heavy work (planning, debugging) to stronger models and
  implementation (coding) to cheaper-but-capable models.
- **Balanced** — one cost-effective model for all modes.
- **Free** — splits traffic across the best free OpenRouter models, adapting as availability changes.

User just picks a tier from the model dropdown; **no manual switching as modes change**. The core
benefit is stated as: "uses the more economical models for more straightforward tasks, while
reserving stronger reasoning models for planning." (Privacy caveat: Auto Free may route to providers
that log prompts; needs extension v5.2.3+ / CLI v1.0.15+.)

Source: https://kilo.ai/docs/code-with-ai/agents/auto-model

### 6.2 OpenRouter integration

All three integrate **OpenRouter** as a provider — one API key, hundreds of models, and caching
pass-through to underlying models that support it. This is the common substrate that makes
per-mode/per-task model swaps and "free model" routing practical without managing N provider keys.

Sources:
- https://docs.cline.bot/provider-config/openrouter
- https://openrouter.ai/works-with-openrouter/cline

### 6.3 Cost tracking / telemetry

- **Cline:** built-in real-time per-task token & cost tracking ("how much each task costs in real
  time, no surprises at month-end"). Aggregate Plan/Act model telemetry is what powered the §2.2
  blog.
- **Roo:** condensing UI shows before/after tokens + the cost of each condensing AI call (per-event
  cost accounting).

---

## 7. Token / cost optimization mechanics (diff edits, truncation, etc.)

- **Diff-based edits:** all three apply edits as diffs rather than rewriting whole files — the model
  emits only changed hunks (fewer output tokens) and the user sees a red/green review diff. Roo
  exposes per-profile "Diff Editing config." This is one of the biggest output-token savers for
  coding.
- **File-read truncation / redundancy removal:** Cline removes duplicate file content first during
  truncation to preserve cache prefix and cut tokens. (Harness-equivalent: read truncation +
  dedup of repeated file snapshots.)
- **Lazy MCP docs:** Cline replaced static ~8k-token MCP instructions in the system prompt with an
  on-demand `load_mcp_documentation` tool — pay only when needed.
- **Tool-group / permission restrictions per mode:** the cheapest token is the one never spent — a
  read-only Plan/Architect/Ask mode physically cannot run expensive edit/command loops.
- **Per-mode temperature** (Roo): deterministic low temp on Code/Debug reduces retries/rework.
- **Rate limiting per profile** (Roo): caps request frequency to avoid runaway spend.
- **Checkpoints + diff revert:** cheap recovery from bad (e.g. cheap-model) output without re-running
  whole tasks.

Sources: as cited in §4 and §6 above.

---

## Consolidated source list

- Cline Plan/Act: https://docs.cline.bot/core-workflows/plan-and-act
- Cline Plan/Act usage data: https://cline.bot/blog/plan-act-model-usage-patterns-in-cline
- Cline Auto Compact: https://docs.cline.bot/features/auto-compact
- Cline context engineering: https://cline.bot/blog/how-to-think-about-context-engineering-in-cline
- Cline caching framework: https://cline.bot/blog/inside-clines-framework-for-optimizing-context-maintaining-narrative-integrity-and-enabling-smarter-ai
- Cline v3.14 (Gemini caching, checkpoints): https://cline.bot/blog/cline-v3-14-improved-gemini-caching-newrule-command-enhanced-checkpoints-key-updates
- Cline OpenRouter: https://docs.cline.bot/provider-config/openrouter
- Cline repo: https://github.com/cline/cline
- Roo using modes: https://docs.roocode.com/basic-usage/using-modes
- Roo custom modes: https://docs.roocode.com/features/custom-modes
- Roo API config profiles: https://docs.roocode.com/features/api-configuration-profiles
- Roo Boomerang/Orchestrator: https://docs.roocode.com/features/boomerang-tasks
- Roo intelligent context condensing: https://docs.roocode.com/features/intelligent-context-condensing
- Kilo custom modes/agents: https://kilo.ai/docs/customize/custom-modes
- Kilo Auto Model: https://kilo.ai/docs/code-with-ai/agents/auto-model
- Kilo per-mode model feature request: https://github.com/Kilo-Org/kilocode/discussions/5341
