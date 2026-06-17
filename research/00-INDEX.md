# Multi-Model & Cost-Saving Strategies in Coding Agents — Research Index

Research compiled 2026-06-17. Goal: survey how every major coding-agent harness uses
multiple models and cheaper options, so harnext (model-agnostic) can route the best/cheapest
model to each task.

## Reports

| # | File | Scope |
|---|------|-------|
| 01 | [01-aider.md](01-aider.md) | **Aider** — architect/editor split, weak-model role, edit formats, repo map, caching |
| 02 | [02-cline-roo-kilo.md](02-cline-roo-kilo.md) | **Cline / Roo Code / Kilo Code** — per-mode model config, Plan vs Act, profiles, orchestrator/Boomerang, Auto routing |
| 03 | [03-continue-roles-and-fast-apply.md](03-continue-roles-and-fast-apply.md) | **Continue.dev model roles** (chat/edit/apply/autocomplete/embed/rerank) + industry **fast-apply** models (Morph, Relace) |
| 04 | [04-cursor-windsurf-copilot.md](04-cursor-windsurf-copilot.md) | **Cursor / Windsurf / Copilot** — Auto routing, Tab model, instant-apply, speculative edits, billing-as-incentive |
| 05 | [05-cli-agents-...md](05-cli-agents-claude-codex-gemini-openhands-goose.md) | **Claude Code / Codex CLI / Gemini CLI / OpenHands / Goose** — small-fast-model slot, plan→execute, quota fallback, per-subagent model |
| 06 | [06-routing-cascades-caching-research.md](06-routing-cascades-caching-research.md) | **Research & frameworks** — RouteLLM, FrugalGPT cascades, prompt caching, speculative decoding, reasoning-budget dials |
| 07 | [07-harnext-recommendations.md](07-harnext-recommendations.md) | **Synthesis applied to harnext** — what exists today + concrete proposals with file hooks |

---

## The one big idea

Every harness that saves money does the same thing: **it stops treating "the model" as a
single global setting and instead decomposes a turn into typed jobs, then assigns the
cheapest model that clears the bar for each job.** Differences are only in *which* jobs they
split out and *how* the model is chosen (manual role config vs automatic routing).

There are three orthogonal levers. Most tools use all three:

1. **Role/task split** — different model per *function* (plan, edit, apply, summarize,
   autocomplete, embed, rerank, classify). Static config.
2. **Routing/cascade** — different model per *individual request*, chosen at runtime by a
   classifier (route) or by trying cheap-first and escalating on failure (cascade).
3. **Per-request knobs** — same model, cheaper call: prompt caching, reasoning-effort/
   thinking-budget, speculative/predicted-outputs editing, output-token minimization (diffs).

---

## Cross-cutting patterns (with who does it)

### A. The "small/fast model" slot — the highest-ROI, lowest-risk pattern
A second, cheap model wired in for non-user-facing housekeeping. Universal.
- **Aider** `--weak-model`: commit messages, chat-history summarization. (01)
- **Claude Code** `ANTHROPIC_SMALL_FAST_MODEL` (Haiku): background tasks, conversation
  summarization, title generation. (05)
- **Gemini CLI**: per-task `modelConfigKey` — Flash for next-speaker check, loop detection,
  tool-output summarization. (05)
- **OpenHands** condenser model: ~2× cost cut from memory condensation, no quality loss. (05)

**Tasks safe to offload to a cheap model:** commit/PR messages, conversation/title
summarization, classification & routing, "should I continue / next speaker" checks, loop
detection, tool-output summarization, file ranking, `old_string`/edit repair.

**Caveat (from Roo, 02):** do *not* naively summarize a transcript that contains tool calls
with a *different* model — structured tool-call/result content causes format-translation
errors. Either keep the same model for that or strip structure first.

### B. Plan ↔ Execute model switch — highest-leverage main-loop pattern
Strong model plans/architects; cheap model executes the mechanical edits.
- **Aider** architect/editor: R1 (plan) + Sonnet (edit) = 64% polyglot at ~14× lower cost
  than o1 alone, with 100% edit-format compliance. (01)
- **Cline** Plan vs Act; **Roo** Architect→Code modes — the real-world winner is
  Opus-plans → Sonnet-executes (~25% of Cline cross-mode usage). (02)
- **Claude Code** `opusplan`; **Goose** `GOOSE_LEAD_MODEL` lead→worker. (05)
- **harnext already has this**: `/goal` runs Planner(strong)→Generator(fast)→Evaluator(strong)
  as isolated sessions. (07)

### C. Separate "reason" from "apply" — the biggest latency+cost lever for edits
Frontier model *describes* an edit (lazy/sketch with `// ... existing code ...`); a tiny,
specialized **fast-apply** model *materializes* the full file at ~1k–10k tok/s.
- **Continue** `apply` role; **Cursor** instant-apply (~1000 tok/s, 9–13×); **Morph/Relace/
  Fireworks** as drop-in OpenAI-compatible apply models. (03, 04)
- Underpinned by **speculative editing / predicted outputs**: the existing file is a free
  "draft", so apply latency scales with edit size, not file size. Exposed publicly via
  OpenAI/Fireworks "Predicted Outputs" — usable without training a model. (04, 06)

### D. Right-size by call-volume × latency, not by difficulty
The most *frequent*, latency-tight ops get the smallest model: autocomplete (tiny FIM model,
≤1024-tok prompt, debounce + hard timeout), apply, embed/rerank. Frontier models reserved for
rare hard reasoning turns. This is the core economic split in Cursor/Windsurf/Copilot. (03, 04)

### E. Automatic routing & cascades
- **Route** (pick before calling): RouteLLM (win-prediction routers transfer across model
  pairs), OpenRouter Auto, NotDiamond, Martian; Cursor/Copilot "Auto". Score difficulty,
  default cheap, escalate only when needed, **switch at cache boundaries**. (04, 06)
- **Cascade** (escalate after failing): FrugalGPT (up to 98% cost cut matching GPT-4),
  AutoMix training-free self-verification (>50% cut, no labeled data needed). Try cheap →
  verify (tests/judge) → escalate to frontier only on failure. (06)
- **Quota fallback** is a degenerate cascade: Gemini CLI Pro→Flash on 429, persistent for the
  session. Distinguish *task* failures from *infra* errors (Goose). (05)

### F. Prompt caching — free 50–90% input savings, pure prompt-structure work
Keep `tools → system → stable-context` byte-identical and append-only; put volatile content
last. Anthropic ~90% read discount, OpenAI ~50% auto, DeepSeek/Gemini context caching. No
routing logic required — the single highest-ROI lever overall. **Gotcha:** changing the
reasoning/thinking budget mid-conversation busts the message cache (Anthropic). (06, 01, 02)

### G. Reasoning-effort / thinking-budget as a per-task dial
Often substitutes for a *second model*. Codex `minimal→xhigh`; Anthropic extended-thinking
budget; Gemini thinking budget. GPT-5 data: high vs medium effort = 65% vs 64% at ~2× cost —
so default medium/off, escalate only for hard reasoning. (05, 06)

### H. Make edits cheap to emit and cheap to recover from
Diff/whole edit formats chosen per-model capability (Aider matches format to model; 01).
Diff-based edits cut output tokens (Kilo; 02). Checkpoints let you run cheap models
aggressively and cheaply revert bad output without re-paying for the task (Cline/Roo/Kilo; 02).

---

## Decision framework: task → model tier

Synthesized from all six reports (see 06 for the research-backed version).

| Task | Tier | Why |
|------|------|-----|
| Architecture / planning / hard debugging | **Frontier** (Opus, GPT-5, Gemini Pro) | Deep reasoning; low frequency, cost amortized |
| Code generation / multi-file edits | **Mid** (Sonnet, GPT-5-mini, Flash) | Strong but cheaper; also good LLM-judge |
| Applying a described edit to a file | **Tiny apply model** (Morph/Relace/Instant Apply) | Mechanical; speculative/predicted outputs, ~1k–10k tok/s |
| Conversation/context compaction & summarization | **Cheap** (Haiku, Flash, mini) | No deep reasoning; high token volume |
| Classification / routing / next-speaker / loop-detect | **Cheap/tiny** | Short, structured, frequent |
| Commit/PR messages, titles | **Cheap/tiny** | Throwaway prose |
| Inline autocomplete (FIM) | **Tiny fast** (Codestral, Qwen Coder, DeepSeek Coder) | Latency-critical, highest frequency |
| Codebase retrieval | **embed** (Voyage/Nomic) + **rerank** (small) | Not LLMs at all |
| Verification / LLM-judge in a cascade | **Mid/frontier** | Gate before escalating; cheap relative to re-doing work |

---

## What harnext can do with this
harnext is model-agnostic across 10 providers, already has a 3-phase `/goal` tiering and
compaction seam, and already ships goal-config model defaults per provider. The gap is that
**compaction and all housekeeping reuse the main model**, there is **no "small/fast model"
slot**, no routing/cascade, and no fast-apply path. See **07** for concrete, file-level
proposals ordered by ROI.
