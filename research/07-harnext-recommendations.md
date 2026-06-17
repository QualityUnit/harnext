# Applying the Research to harnext — What Exists, What's Missing, What to Build

This synthesizes reports 01–06 against harnext's actual architecture (mapped from source).
All file references are to `/home/yasha/Desktop/projects/harnext2`.

## 1. What harnext already has (better than most)

| Capability | Where | Notes |
|---|---|---|
| **Model-agnostic core** — 10 providers, custom resolution for OpenRouter/NVIDIA/Ollama | `packages/core/src/providers.ts:31-66`, `sdk.ts:171-212` | This is the *foundation* every other harness has to bolt on. harnext starts here. |
| **Runtime model switching** | `interactive-mode.ts:1325-1329` mutates `agent.state.model`; `/model` cmd at `:97-115` | Single global model though — switches everything at once. |
| **Plan→execute tiering (3-phase)** | `goal-runner.ts:93-150`, `goal-config.ts:80-123` | `/goal` runs Planner(strong)→Generator(fast)→Evaluator(strong) as **isolated sessions**. Defaults: Anthropic Opus/Haiku; OpenRouter deepseek pro/flash. Customizable via `~/.harnext/agent/goal-config.json`. This is exactly the Aider-architect / Goose-lead pattern (01, 05). |
| **Compaction seam** | `compaction.ts`, wired at `sdk.ts:437-439` via pi-agent-core `transformContext` | Summarizes when token budget exceeded. **Currently reuses the main model** (`callSummaryLlm`, compaction.ts:226-251). |
| **Real token accounting** | `compaction.ts:57-60` uses API-reported `usage.input+output` | Enables accurate cost tracking / routing decisions. |
| **Single LLM invocation point** | `sdk.ts:407-424` `streamFn` → `streamSimple` | One clean seam to add per-call model/knob selection. |

**Key insight:** harnext is unusually well-positioned. The hard part (provider abstraction +
plan/execute) is done. The missing pieces are the *cheap-housekeeping* and *per-call routing*
layers that the research shows give most of the savings.

## 2. Gaps vs. the field

1. **No "small/fast model" slot.** Compaction, and any future summarization/classification,
   reuse the expensive main model. Every CLI agent (Claude Code, Gemini CLI, Aider, OpenHands)
   has a dedicated cheap model for this. *This is the #1 gap.* (05, 01)
2. **No routing or cascade.** Model is chosen by the human, never by the task. (04, 06)
3. **No reason→apply split.** Edits are emitted directly by the main model via `edit`/`write`
   (`tools/edit.ts:49` plain `content.replace()`); no cheap fast-apply path. (03, 04)
4. **No reasoning-effort/thinking-budget per task** beyond a session `thinkingLevel`. (05, 06)
5. **Single global model switch** — can't run a cheap model for tools and a strong one for
   reasoning in the *same* session (Roo/Cline do this per-mode). (02)

## 3. Proposals, ordered by ROI

### P1 — Add a secondary "fast model" slot (do this first)
Highest ROI, lowest risk, smallest change. Mirrors `ANTHROPIC_SMALL_FAST_MODEL` / Aider
`--weak-model`.

- Add `fastModel?: Model<string>` to `AgentSessionConfig` (`agent-session.ts:22`) and
  `CreateAgentSessionOptions` (`sdk.ts`). Resolve it the same way the main model is resolved
  (`sdk.ts:171-212`). Default: reuse `goal-config.ts` per-provider `fast` default (Haiku for
  Anthropic, deepseek-flash for OpenRouter), falling back to the main model.
- Thread it into compaction: change `callSummaryLlm` (`compaction.ts:226-251`) and
  `createCompaction` (`sdk.ts:437-439`) to accept and use `fastModel ?? model`.
- CLI: `--fast-model` flag + persist in `preferences.ts`; show in `/model` picker as a second
  slot.

**Immediate payoff:** compaction (which runs repeatedly on long sessions) stops paying
frontier prices. Then reuse the same slot for items in P2.

### P2 — Route housekeeping subtasks to the fast model
Once P1 exists, offload these (all validated by the research as cheap-model-safe):
- Conversation/context compaction (P1).
- Commit/PR message generation, session title generation.
- Any classifier you add (e.g. "is this turn trivial?" for P4 routing).

**Caveat from Roo (02):** transcripts containing tool calls/results can break when summarized
by a *different* cheap model (structured-content translation errors). Mitigate by stripping
tool-call structure to plain text before summarizing, or keep same-model for that one path and
use the fast model only for clean-prose tasks. Test on a tool-heavy transcript.

### P3 — Reason→apply split with a fast-apply model (biggest edit-cost win)
Pattern from Continue/Cursor/Morph (03, 04). Two ways to adopt without training anything:
- **(a) Predicted Outputs / speculative edit** — when the main model rewrites a file, pass the
  existing file as the `prediction`/draft (OpenAI & Fireworks expose this). Apply latency/cost
  scales with edit size, not file size. Hook at `streamFn` (`sdk.ts:407`) or in a new
  `apply`-style tool.
- **(b) Lazy-edit + fast-apply model** — main model emits a sketch with
  `// ... existing code ...` markers; a cheap OpenAI-compatible apply model (Morph/Relace, or a
  local Qwen-Coder via the existing Ollama path) materializes the full file. New tool
  `apply_edit` alongside `tools/edit.ts`; route it to `fastModel` or a dedicated `applyModel`.

Start with (a) for OpenAI/Fireworks providers — near-zero new infra, just a request param.

### P4 — Optional auto-routing / cascade (opt-in)
Defer until P1–P3 land. Two flavors (06):
- **Route:** a tiny classifier (run on `fastModel`) scores each user turn's difficulty and
  picks tier; default cheap, escalate for hard turns. Switch **at cache boundaries** to avoid
  busting the prompt cache.
- **Cascade:** try `fastModel` first; verify with a cheap check (tests pass / LLM-judge); on
  failure, re-run the turn on the frontier model. FrugalGPT/AutoMix show large savings; self-
  verification needs no training data.

Expose as a `model-strategy.json` (`~/.harnext/agent/`) loaded in `sdk.ts` near
`loadSettings()`, plus a `/model-strategy` command. Keep **off by default**.

### P5 — Prompt-caching hygiene (free, do alongside P1)
Pure prompt-structure work, 50–90% input savings (06):
- Ensure `tools → system prompt → MEMORY.md/stable context` are emitted byte-identical and
  append-only across turns; put volatile content (latest tool outputs) last. Audit how
  `system-prompt.ts` + memory injection order interacts with `convertToLlm`.
- Don't change `thinkingLevel` mid-conversation if the provider caches messages (Anthropic
  busts cache on budget change).

### P6 — Per-call reasoning-effort dial
Expose Codex-style effort per task (05, 06): low/minimal for housekeeping & simple edits, high
for planning/debug. For Anthropic, map to extended-thinking budget; for OpenAI, reasoning
effort. Can substitute for a second model on providers that support it. Hook at `streamFn`
opts (`sdk.ts:407-424`), keyed off task type.

## 4. Suggested sequencing

1. **P1 + P5** together — fast-model slot + caching hygiene. Small, safe, immediate savings on
   every long session.
2. **P2** — move commit-message/title/classification onto the fast model.
3. **P3(a)** — predicted-outputs speculative edit for OpenAI/Fireworks.
4. **P6** — per-task effort dial.
5. **P3(b)** — full lazy-edit + fast-apply model (incl. local Ollama apply).
6. **P4** — opt-in routing/cascade once telemetry from P1–P3 shows where money actually goes.

## 5. Design principles carried over from the research

- **Profile-as-the-unit, not model-as-the-unit** (Roo, 02): a "mode/role" references a named
  provider+model+knobs bundle; swapping providers is atomic. harnext's `goal-config.json` is
  already this shape — generalize it.
- **Default to the cheapest capable model; make escalation explicit** (Cursor/Copilot, 04).
- **Right-size by call-volume × latency, not difficulty** (Continue, 03): the most frequent,
  latency-tight ops get the smallest model.
- **No silent caps** — when routing sends work to a cheap model, surface it (telemetry/logging)
  so users can audit cost vs. quality.
- **Keep wire formats provider-neutral** (Continue, 03): per-role prompt templates + OpenAI-
  compatible base URLs let one config span Anthropic/Mistral/Voyage/Morph/Ollama. harnext's
  custom-resolution providers already lean this way.
