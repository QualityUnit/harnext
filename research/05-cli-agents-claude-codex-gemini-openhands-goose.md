# Multi-Tier & Cheap-Model Strategies in Terminal/CLI Coding Agents

**Subjects:** Claude Code · OpenAI Codex CLI · Gemini CLI · OpenHands (OpenDevin) · Goose (Block)
**Focus:** How each agent uses multiple model tiers, when it delegates work to cheaper/faster models, and the concrete env vars / config keys / slash commands that control it.
**Method:** Primary sources only — official docs, GitHub source, engineering blogs. Citations inline as URLs.
**Date:** 2026-06-17

---

## Executive summary

Every mature CLI coding agent has converged on the same core insight: **the main reasoning model is too expensive to run for every operation.** They split work along two axes:

1. **User-facing tiering** — a knob (`/model`, aliases, profiles) for the human to pick frontier vs. cheap models for the *main* loop, plus a planner/executor split.
2. **Invisible internal offloading** — the agent silently routes housekeeping (summarization, classification, edit repair, "should I keep talking?" checks) to a cheaper tier, regardless of the main model.

Gemini CLI is the most aggressive at #2 (a whole table of internal subtasks pinned to Flash/Flash-Lite). Claude Code formalizes #1 with the `opusplan` plan→execute switch and a deprecated-but-canonical "small fast model" for background jobs. Goose pioneered an automatic turn-based lead→worker handoff (now replaced by planner mode). Codex leans on **reasoning effort** rather than a second model. OpenHands exposes the most explicit per-role multi-LLM config (`[llm.draft_editor]`, `[llm.condenser]`).

---

## 1. Claude Code (Anthropic)

> Docs note: Claude Code docs moved from `docs.claude.com/en/docs/claude-code/*` to **`code.claude.com/docs/en/*`** (301 redirects). Model IDs cited reflect the current generation (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 / Fable 5); the *mechanisms* are stable across versions.

### 1.1 Tiering: Opus / Sonnet / Haiku (+ Fable)

Tiers are exposed as **aliases** that resolve to "the recommended version for your provider and update over time" ([model-config](https://code.claude.com/docs/en/model-config)):

| Alias | Intended use |
|---|---|
| `haiku` | "fast and efficient … for simple tasks" |
| `sonnet` | "latest Sonnet … for daily coding tasks" (the workhorse default for most accounts) |
| `opus` | "latest Opus … for complex reasoning tasks" |
| `fable` | "Claude Fable 5 for your hardest and longest-running tasks" (new flagship; never a default) |
| `best` | Fable 5 where the org has access, else latest Opus |
| `default` | Clears any override; reverts to account-recommended model |
| `sonnet[1m]` / `opus[1m]` | Same tier with 1M-token context for long sessions |
| `opusplan` | **Opus during plan mode, then Sonnet for execution** (see §1.5) |

The **default is account-dependent**, not fixed ([costs](https://code.claude.com/docs/en/costs), model-config): Max/Team-Premium/Enterprise-PAYG/API → Opus 4.8; Pro/Team-Standard/Enterprise-seat → Sonnet 4.6; Bedrock/Vertex/Foundry → Sonnet 4.5. Guidance: "Sonnet handles most coding tasks well and costs less than Opus. Reserve Opus for complex architectural decisions… For simple subagent tasks, specify `model: haiku`."

### 1.2 The "small fast model" — what Haiku actually does

The canonical small/fast model is configured by **`ANTHROPIC_SMALL_FAST_MODEL`**, documented verbatim in [env-vars](https://code.claude.com/docs/en/env-vars) as:

> `ANTHROPIC_SMALL_FAST_MODEL` — `[DEPRECATED] Name of Haiku-class model for background tasks`

It is **deprecated in favor of `ANTHROPIC_DEFAULT_HAIKU_MODEL`** (model-config). The four alias-pinning env vars (all take full model IDs):

| Env var | Controls |
|---|---|
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `opus`, and `opusplan` while plan mode is active |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `sonnet`, and `opusplan` while plan mode is *not* active |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `haiku` **and background functionality** |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `fable`, and the ID recognized as Fable 5 for fallback |

**Exactly which tasks go to Haiku** — the authoritative list is the "Background token usage" section of [costs](https://code.claude.com/docs/en/costs#background-token-usage):

- **Conversation summarization** — "Background jobs that summarize previous conversations for the `claude --resume` feature."
- **Command processing** — "Some commands like `/usage` may generate requests to check status."

These cost "typically under $0.04 per session." (The deprecated var's own description — "Haiku-class model for background tasks" — corroborates this is the model behind them.) A *separate* server-side model handles the auto-mode safety **classifier**, which is "independent of your `/model` selection" ([permission-modes](https://code.claude.com/docs/en/permission-modes)) — another example of routing non-primary work off the main model.

### 1.3 Subagents with their own model

The `model:` frontmatter field ([sub-agents](https://code.claude.com/docs/en/sub-agents)) accepts: an alias (`sonnet`/`opus`/`haiku`/`fable`), a full model ID (e.g. `claude-opus-4-8`), or `inherit`. **Defaults to `inherit`.** Resolution order: (1) `CLAUDE_CODE_SUBAGENT_MODEL` env var → (2) per-invocation `model` param → (3) frontmatter `model` → (4) main conversation model. The docs frame subagents as a cost lever: "Control costs by routing tasks to faster, cheaper models like Haiku." Built-in subagents demonstrate it: **Explore → Haiku** (read-only codebase search), **claude-code-guide → Haiku**, **statusline-setup → Sonnet**, **Plan / general-purpose → inherit**.

### 1.4 `/model` switching

`/model <alias|name>` switches mid-session; bare `/model` opens a picker. Precedence: `/model` (session) > `--model` at startup > `ANTHROPIC_MODEL` env > `model` field in settings. `[1m]` suffix works on aliases or IDs (`/model opus[1m]`, `/model claude-opus-4-8[1m]`). Enterprises can restrict the picker via `availableModels` (e.g. `["sonnet","haiku"]`).

### 1.5 Plan mode & `opusplan`

Two distinct things share "plan": **Plan mode is a *permission* mode** (research/propose, no writes) and by itself does *not* change the model. **`opusplan` is the alias that ties a model switch to the plan/execute boundary** ([model-config](https://code.claude.com/docs/en/model-config)): "In plan mode — Uses `opus`… In execution mode — Automatically switches to `sonnet`." This is the headline "expensive planning, cheap execution" pattern. Edge cases: if `availableModels` excludes Opus, `opusplan` stays on Sonnet in plan mode; `opusplan[1m]` forces 1M context in both phases.

### 1.6 Compaction — which model summarizes

Two summarization paths use **different** models:
- **In-session `/compact` + auto-compact** (when nearing the context limit) — part of the *main* session's context management; the docs do **not** assign this to Haiku. Steerable with `/compact <instructions>` or CLAUDE.md compact instructions.
- **Resume/history conversation summarization** — the documented background job that *does* run on the Haiku-class small/fast model (§1.2).

So: treat any claim that live `/compact` runs on Haiku as **unverified**; only the resume-summarization background job is documented as cheap-model work.

---

## 2. OpenAI Codex CLI

> Docs at **developers.openai.com/codex**; user config in `~/.codex/config.toml`. The current documented lineup is the gpt-5.4 / gpt-5.5 generation (the earlier gpt-5-codex / o4-mini names are deprecated). Codex's primary cost lever is **reasoning effort**, not a second model.

### 2.1 Model selection

Four mechanisms ([models](https://developers.openai.com/codex/models)): config `model = "gpt-5.5"`; flag `codex -m`/`--model`; one-off override `codex -c model_reasoning_effort="high"`; slash command `/model` (mid-thread switch). The cheaper tier is **`gpt-5.4-mini`** — "Fast, efficient option for responsive coding tasks **and subagents**." The default is the auth-inferred recommended frontier model (currently gpt-5.x), not a hardcoded ID.

### 2.2 Reasoning effort — the cost lever

Config key **`model_reasoning_effort`** ([config-reference](https://developers.openai.com/codex/config-reference)): values `minimal | low | medium | high | xhigh`, default **`medium`**. "Adjust reasoning effort for supported models (Responses API only)." Lower = cheaper/faster (fewer reasoning tokens); higher = more tokens/cost/quality. Set via config, launch override `-c model_reasoning_effort=…`, or the `/reasoning` slash command. Related: `plan_mode_reasoning_effort` (plan-mode-specific override), `model_reasoning_summary` (`auto|concise|detailed|none`), `model_verbosity` (`low|medium|high`).

### 2.3 Profiles & subagents

**Profiles** ([config-advanced](https://developers.openai.com/codex/config-advanced)) bundle model + reasoning effort + settings. Modern syntax: a `~/.codex/<name>.config.toml` file activated with `codex --profile <name>`. This is the "cheaper-model-for-this-workflow" mechanism (e.g. a `quick` profile = `gpt-5.4-mini` + `low`, a `deep` profile = `gpt-5.5` + `xhigh`). **Subagents** are configured under `[agents]`; the docs explicitly position `gpt-5.4-mini` for subagents, so the orchestrator can run a frontier model while subagents run cheaper. `/review` has an optional `review_model` (defaults to session model).

### 2.4 Compaction

Auto-compacts near the context limit. Keys: `model_auto_compact_token_limit` (trigger threshold), `compact_prompt` / `experimental_compact_prompt_file` (override the compaction prompt), `tool_output_token_limit`. **Compaction runs on the active session model — there is no separate/cheaper compaction model.** Confirmed by open request [openai/codex #22486](https://github.com/openai/codex/issues/22486): "users who want a high-capability model for real work appear to also pay that same model/cost/latency profile for compaction." No documented title-generation model.

---

## 3. Gemini CLI (Google)

> Source: `google-gemini/gemini-cli`. `main` has moved past the 2.5 era into a Gemini-3 preview branch and refactored hardcoded model constants into a named **model-config alias** system (`defaultModelConfigs.ts`). The 2.5 constants still exist in source.

### 3.1 Model selection

Precedence: settings.json `model.name` → `GEMINI_MODEL` env → `--model`/`-m` flag → `/model` command. The settings key is nested: `{ "model": { "name": "gemini-2.5-pro" } }`. Constants ([models.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/models.ts)): `DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro'`, `DEFAULT_GEMINI_FLASH_MODEL = 'gemini-2.5-flash'`, `DEFAULT_GEMINI_FLASH_LITE_MODEL = 'gemini-3.1-flash-lite'`, plus aliases `auto`/`pro`/`flash`/`flash-lite`. The *runtime* flag default is the alias `"auto"`. `/model` does **not** override sub-agent models.

### 3.2 Automatic Pro → Flash fallback (the headline feature)

On persistent quota/rate-limit errors, Gemini CLI **automatically and persistently** switches the session from Pro to Flash. Mechanism ([retry.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/retry.ts) → [fallback/handler.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/fallback/handler.ts)): the retry loop fires an `onPersistent429(authType, error)` callback that resolves a per-model **policy chain** and picks the first available fallback candidate, then resets the attempt counter and retries.

- **Triggers:** `TerminalQuotaError` (daily quota exhausted) → fallback **immediately**; `RetryableQuotaError` → retries up to the chain's `maxAttempts` (e.g. 3 on the Pro chain), then falls back. Retryable statuses: 429/499/5xx. `DEFAULT_MAX_ATTEMPTS = 10`.
- **Who:** primarily **free OAuth ("Login with Google") users**; the unpaid API-key tier is Flash-only (no Pro at all).
- **Persistence:** `activateFallbackMode()` installs a session-long override and emits `FlashFallbackEvent`; message: "Switching to the {model} model for the rest of this session."
- **No off-switch:** a disable flag was explicitly **declined** ([#2208](https://github.com/google-gemini/gemini-cli/issues/2208)). Only tunable via `model.maxAttempts` and `model.chains` (behind `experimental.enableDynamicModels`). Default chain routes `gemini-2.5-pro → gemini-2.5-flash` (`isLastResort: true`).

### 3.3 Internal subtasks offloaded to Flash / Flash-Lite

Gemini CLI is the **most aggressive internal offloader**. Each task carries a `modelConfigKey` ([defaultModelConfigs.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/defaultModelConfigs.ts)):

| Internal task | Tier |
|---|---|
| **Next-speaker check** ("should the model continue?") | Flash |
| **Loop-detection** LLM screening (after 30 turns, 0.9 confidence) | Flash (escalates to **Pro** double-check on a hit) |
| **Edit correction** (repair mismatched `old_string`) | Flash-Lite |
| **Routing classifier** (route turn → Flash vs Pro) | Flash-Lite |
| Tool/shell output **summarizers** | Flash-Lite |
| Prompt completion / ghost text, fast-ack helper | Flash-Lite |
| Web search / web fetch tools | Flash |
| Subagent history summarizer | Flash |

These configs are deliberately cheap (e.g. classifier `maxOutputTokens:1024, thinkingBudget:512`; fast-ack `thinkingBudget:0`).

### 3.4 Chat-history compression

Auto-compresses ([chatCompressionService.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/context/chatCompressionService.ts)): `DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5` (compress at **50%** of the model's token limit — *not* 70%), `COMPRESSION_PRESERVE_THRESHOLD = 0.3` (keep newest 30%, summarize oldest 70%). The summarizer is **tier-matched to the active session model** (Pro session → Pro compressor, Flash session → Flash compressor), producing a structured XML `<state_snapshot>` with prompt-injection defenses. Overridable via the `compressionThreshold` setting; manual trigger `/compress`. Context limit: `DEFAULT_TOKEN_LIMIT = 1_048_576`.

---

## 4. OpenHands (All Hands AI; formerly OpenDevin)

> Model-agnostic via LiteLLM. Note the split between the **legacy `config.toml`-driven app** and the newer **Agent SDK**. Custom/named LLM configs apply only in dev mode (`main.py`/`cli.py`), **not in standard Docker**.

### 4.1 Multi-LLM: `[llm]` + named `[llm.<name>]`

A default `[llm]` section plus any number of named sub-configs that **inherit `[llm]` and override selectively** ([custom-llm-configs](https://docs.openhands.dev/usage/llms/custom-llm-configs)). Roles reference them via `llm_config`:

```toml
[llm]
model = "gpt-4"
[llm.gpt3]
model = "gpt-3.5-turbo"
[agent.RepoExplorerAgent]
llm_config = 'gpt3'          # cheap model for a low-stakes agent
```

The docs explicitly call out "use a cheaper model for tasks that don't require high-quality responses."

### 4.2 Draft editor (`[llm.draft_editor]`)

A reserved named config for "preliminary drafting of code edits." Activated by `[agent] enable_llm_editor = true` ([config.template.toml](https://github.com/All-Hands-AI/OpenHands/blob/main/config.template.toml)); `[llm.draft_editor]` picks the model (low temperature). When disabled, the simpler `str_replace_editor` tool is used. This is OpenHands' explicit "cheap secondary model for a subtask" pattern.

### 4.3 Condenser / memory condensation

Condensers compress history; "each agent uses one condenser." `enable_default_condenser = true` makes **LLMSummarizingCondenser** the default. Types via `[condenser] type`: `noop`, `observation_masking` (`attention_window`), `recent` (`keep_first`, `max_events`), `llm` (`llm_config`, `keep_first`, `max_size`), `amortized`, `llm_attention` (`llm_config`, …). **The LLM-backed condensers take `llm_config = "condenser"`**, pointing at a dedicated named `[llm.condenser]` block (falls back to default `[llm]` if omitted) — i.e. **a separate, typically cheaper, model for summarization.** The SDK ([sdk/arch/condenser](https://docs.openhands.dev/sdk/arch/condenser)) states the condenser LLM is "often a cheaper model than the reasoning LLM" (defaults `max_size=120`, `keep_first=4`). Reported impact: **up to 2× per-turn cost reduction with no quality loss** ([blog](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents)).

### 4.4 Agent delegation

Legacy: `AgentDelegateAction` lets one agent hand a subtask to a specialist (e.g. CodeActAgent → BrowsingAgent); each delegated agent can carry its own `[agent.<Name>] llm_config`, so **different sub-agents can run different models** (dev mode). SDK: `DelegateTool` (parallel) / `TaskToolSet` (sequential); documented sub-agents **inherit the parent LLM by default**, but each `Agent` is built with its own `LLM`, so per-agent models are structurally possible.

---

## 5. Goose (Block)

> **Important:** Goose has two distinct multi-model features from different eras. **Lead/Worker (the `GOOSE_LEAD_*` feature) has been REMOVED** and replaced by Planner Mode. Lead/Worker details below are verified against historical source (tag v1.2.0) and accurate for that era, but will not work in current releases.

### 5.1 Lead/Worker split (deprecated — but the canonical example of this pattern)

Concept: start on a strong **lead** model for planning, hand off after a few turns to a faster/cheaper **worker**, and snap back to the lead if the worker gets stuck. Configured entirely by env vars ([factory.rs](https://github.com/block/goose), `create_lead_worker_from_env`):

| Env var | Purpose | Default |
|---|---|---|
| `GOOSE_LEAD_MODEL` | Lead model; **its presence is the on-switch** | (required) |
| `GOOSE_LEAD_PROVIDER` | Lead provider | falls back to `GOOSE_PROVIDER` |
| `GOOSE_LEAD_TURNS` | Lead turns before handoff to worker | **3** |
| `GOOSE_LEAD_FAILURE_THRESHOLD` | Consecutive **task** failures that trigger fallback to lead | **2** |
| `GOOSE_LEAD_FALLBACK_TURNS` | Turns the lead stays active during fallback | **2** |

**The worker IS the default `GOOSE_MODEL`/`GOOSE_PROVIDER`** — there is no `GOOSE_WORKER_MODEL`. Switching logic ([lead_worker.rs](https://github.com/block/goose)): turns `0..lead_turns` run lead, then worker; fallback to lead fires when consecutive *task* failures hit the threshold. Crucially, **API/infra errors do NOT count** — only real task failures: tool errors, error strings in output (`"error:"`, `"traceback"`, `"syntax error"`, `"permission denied"`, `"test failed"`…), and user-correction phrases (`"that's wrong"`, `"try again"`, `"fix this"`…). ([Blog](https://block.github.io/goose/blog/2025/06/16/multi-model-in-goose).)

### 5.2 Planner mode (`/plan`) — the current feature

`/plan` (CLI only) enters an interactive plan mode that asks clarifying questions, then offers "clear message history & act on this plan?" → plan-then-execute in one session; `/endplan` exits without acting. The planner model is a **deliberate two-model split today**: `GOOSE_PLANNER_PROVIDER` + `GOOSE_PLANNER_MODEL` (fall back to `GOOSE_PROVIDER`/`GOOSE_MODEL` if unset). Docs pair a strong planner (gpt-4.1) with a strong executor (Claude Sonnet). ([creating-plans](https://block.github.io/goose/docs/guides/context-engineering/creating-plans).)

### 5.3 Recipes & subagents

**Recipes** override model per workflow via `settings: { goose_provider, goose_model, temperature, max_turns }` ([recipe-reference](https://block.github.io/goose/docs/guides/recipes/recipe-reference)) — the modern per-task model tier. **Subagents** inherit parent config and run recipes, so subagent model tiering is achieved through recipe `settings.goose_model`; max turns default **25** (`GOOSE_SUBAGENT_MAX_TURNS` or `settings.max_turns`). Goose can also wrap external agents (e.g. Codex) as MCP-server subagents on a wholly different model.

---

## 6. Cross-cutting: which subtasks get offloaded to cheap models

Consolidated across all five agents. The recurring pattern is a **small/fast model for non-user-facing housekeeping**, plus a **strong-plan → cheap-execute** main-loop split.

| Subtask | Who offloads it to a cheap model | Mechanism |
|---|---|---|
| **History compaction / summarization** | Gemini CLI (tier-matched), OpenHands (`[llm.condenser]`, explicitly cheaper), Claude Code (resume-summarization on Haiku background job) | Dedicated condenser/compressor; ~2× cost cut reported (OpenHands) |
| **Conversation / resume summarization** | Claude Code (Haiku background job) | `ANTHROPIC_SMALL_FAST_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| **Classification / routing** ("which model should handle this turn?") | Gemini CLI (`classifier` → Flash-Lite) | Router strategy picks Flash vs Pro per turn |
| **Next-speaker / "should I continue?" check** | Gemini CLI (`next-speaker-checker` → Flash) | Cheap JSON LLM call each turn |
| **Loop detection** | Gemini CLI (Flash screen → Pro double-check) | Hybrid: deterministic + periodic cheap LLM check |
| **Tool-call / edit repair** (fix mismatched `old_string`) | Gemini CLI (`edit-corrector` → Flash-Lite); OpenHands draft editor | Cheap pass to draft/fix edits |
| **Tool-output summarization** | Gemini CLI (`summarizer-*` → Flash-Lite) | Compress verbose shell/tool output before it hits main context |
| **Prompt completion / ghost text** | Gemini CLI (Flash-Lite) | Low-latency autocomplete |
| **Web search / fetch** | Gemini CLI (Flash) | Sub-tool on cheaper tier |
| **Subagents** | Claude Code (`model: haiku`), Codex (`gpt-5.4-mini`), Goose (recipe `goose_model`), OpenHands (`llm_config`) | Per-agent/per-recipe model override |
| **Planning vs execution** | Claude Code (`opusplan`), Goose (planner mode / ex-lead-worker), Codex (`plan_mode_reasoning_effort`) | Strong model plans, cheaper model executes |
| **Status / command processing** | Claude Code (Haiku, e.g. `/usage`) | Background lightweight requests |
| **Safety classification** | Claude Code (server-side model, independent of `/model`) | Off-main-model classifier |

Notably **absent / not-yet-offloaded:** commit-message and title generation are not documented as separate cheap-model tasks in any of the five (Codex/Claude compaction both run on the *session* model). Codex uniquely substitutes **reasoning effort** for a second model entirely.

---

## Primary sources

**Claude Code:** [model-config](https://code.claude.com/docs/en/model-config) · [costs](https://code.claude.com/docs/en/costs) · [sub-agents](https://code.claude.com/docs/en/sub-agents) · [env-vars](https://code.claude.com/docs/en/env-vars) · [permission-modes](https://code.claude.com/docs/en/permission-modes)
**Codex CLI:** [models](https://developers.openai.com/codex/models) · [config-reference](https://developers.openai.com/codex/config-reference) · [config-advanced](https://developers.openai.com/codex/config-advanced) · [config-sample](https://developers.openai.com/codex/config-sample) · [compaction-model request #22486](https://github.com/openai/codex/issues/22486)
**Gemini CLI:** [models.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/models.ts) · [defaultModelConfigs.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/defaultModelConfigs.ts) · [retry.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/retry.ts) · [fallback/handler.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/fallback/handler.ts) · [chatCompressionService.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/context/chatCompressionService.ts) · [docs/cli/model.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/model.md) · [fallback disable declined #2208](https://github.com/google-gemini/gemini-cli/issues/2208) · [launch blog](https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemini-cli-open-source-ai-agent/)
**OpenHands:** [config.template.toml](https://github.com/All-Hands-AI/OpenHands/blob/main/config.template.toml) · [custom-llm-configs](https://docs.openhands.dev/usage/llms/custom-llm-configs) · [SDK condenser](https://docs.openhands.dev/sdk/arch/condenser) · [SDK agent-delegation](https://docs.openhands.dev/sdk/guides/agent-delegation) · [condensation blog](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents) · [paper arXiv:2407.16741](https://arxiv.org/pdf/2407.16741)
**Goose:** [creating-plans](https://block.github.io/goose/docs/guides/context-engineering/creating-plans) · [multi-model guide](https://block.github.io/goose/docs/guides/multi-model/) · [lead/worker blog](https://block.github.io/goose/blog/2025/06/16/multi-model-in-goose) · [recipe-reference](https://block.github.io/goose/docs/guides/recipes/recipe-reference) · [subagents](https://block.github.io/goose/docs/guides/context-engineering/subagents) · source `crates/goose/src/providers/{factory,lead_worker}.rs` in [block/goose](https://github.com/block/goose)
