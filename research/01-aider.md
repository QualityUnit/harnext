# Aider: Multi-Model & Cost-Saving Strategies

Research into how **Aider** (the open-source AI pair-programming tool by Paul Gauthier) splits work across models and minimizes token/dollar cost. Sourced from primary docs (aider.chat) and Paul Gauthier's blog posts. Dated 2026-06-17.

---

## 0. TL;DR — the core idea

Aider treats "an LLM coding turn" as **several jobs with different difficulty/cost profiles**, and assigns a *different model to each job*:

| Job | Model role | Flag | Why a different model |
|-----|-----------|------|----------------------|
| Reason about *how* to solve the task | **main / architect** | `--model` | Needs the smartest (often most expensive) model |
| Convert that plan into machine-applicable edits | **editor** | `--editor-model` | A cheaper, format-disciplined model is enough |
| Write commit messages, summarize chat history | **weak** | `--weak-model` | Trivial NLP; a cheap/fast model is plenty |

Layered on top: **edit formats** (matched to model skill), the **repo map** (cheap whole-repo context instead of full files), and **prompt caching** (cut the cost of the static prefix). The headline result: pairing a strong reasoner (DeepSeek R1) as architect with a cheaper editor (Sonnet) hit **64.0% SOTA on the polyglot benchmark at ~14× lower cost than o1 alone**.

---

## 1. Architect / Editor mode

### Why it exists
The pattern was motivated by OpenAI's `o1` reasoning models: *"They are strong at reasoning, but often fail to output properly formatted code editing instructions."* Forcing one model to **both** solve the problem **and** conform to a strict edit format divides its attention and hurts both. The Architect/Editor split removes that constraint — the architect reasons in free-form natural language, and a second model rewrites that prose into applicable edits.

### The two-request flow
Architect mode (a.k.a. `edit_format: architect`) runs **two LLM requests per user turn**:

1. **Architect request** — the *main* model (`--model`) reads the request + context and describes a solution **naturally, with no formatting constraints**.
2. **Editor request** — Aider feeds the architect's prose to the *editor* model (`--editor-model`), which emits properly formatted edits (search/replace blocks or whole files) that Aider applies to disk.

This costs more latency and more tokens than single-shot "code" mode (two round-trips), but yields higher accuracy for reasoning-heavy models.

### How to invoke
```bash
aider --architect --model r1 --editor-model sonnet
# or persistently:  /chat-mode architect
# or per-message:   /architect <request>   /code   /ask   /help
```
- `--architect` is shorthand for `--chat-mode architect` / `--edit-format architect`.
- Aider **auto-selects a default editor model** based on the main model; `--editor-model` overrides it.
- The editor's format is controlled by `--editor-edit-format` (recommended values: `editor-diff`, `editor-whole`).

### Recommended model pairs & benchmark numbers

**Original architect post (Sept 2024, code-editing benchmark, % pass):**

| Architect | Editor | Editor format | Pass rate |
|-----------|--------|---------------|-----------|
| o1-preview | o1-mini | whole | **85.0%** |
| o1-preview | deepseek | whole | **85.0%** |
| o1-preview | claude-3.5-sonnet | diff | 82.7% |
| o1-preview | (single model, baseline) | diff | 79.7% |
| claude-3.5-sonnet | claude-3.5-sonnet | diff | 80.5% |
| claude-3.5-sonnet | (baseline) | diff | 77.4% |
| gpt-4o | gpt-4o | diff | 75.2% |
| gpt-4o | (baseline) | diff | 71.4% |
| o1-mini | deepseek | whole | 71.4% |
| o1-mini | (baseline) | diff | 61.1% |

Takeaways from the data:
- Architect/editor **lifts almost every model above its own single-model baseline** (e.g. o1-mini 61.1% → 71.4%, gpt-4o 71.4% → 75.2%).
- The 85% SOTA pairings use the `whole` editor format (full file rewrites) — accurate but *"quite slow, probably not practical for interactive use."*
- `o1-preview` architect + `claude-3.5-sonnet` editor (diff) was called *"entirely practical"* — the recommended real-world combo at the time.

**R1 + Sonnet update (Jan 2025, polyglot benchmark):**

| Config | Pass rate | Edit-format compliance | Total cost |
|--------|-----------|------------------------|-----------|
| **R1 (architect) + Sonnet (editor)** | **64.0%** | 100.0% | **$13.29** |
| o1 (single model, prior SOTA) | 61.7% | — | $186.50 |

```bash
aider --architect --model r1 --editor-model sonnet
```
- New SOTA on polyglot at the time, **~14× cheaper than o1** ($13.29 vs $186.50).
- Notably, it pairs **R1's standard output (not its hidden reasoning tokens)** with Sonnet as editor and beat using either model alone.

**Related insight — "QwQ is a code architect, not an editor" (Dec 2024):** some reasoning models (QwQ) score well *only* when used strictly as the architect and never as the editor, reinforcing that "reason" and "format edits" are genuinely separable skills.

---

## 2. Model roles: main, editor, weak

Aider runs up to **three concurrent model identities** in one session, each with its own default and override flag:

### Main model — `--model` / `/model`
The primary chat model. In architect mode it *is* the architect. Smartest/most expensive model; carries the reasoning load. Default is provider/onboarding-dependent (e.g. onboarding now defaults paid OpenRouter users to `anthropic/claude-sonnet-4`, free tier to `deepseek/deepseek-r1:free`).

### Editor model — `--editor-model` / `/editor-model`
*"Specify the model to use for editor tasks."* Only active in architect mode. Turns the architect's prose into file edits. A cheaper model suffices because **the hard thinking is already done** — the editor only needs to be reliable at producing parseable diffs/whole-files. Defaults are chosen per main model.

### Weak model — `--weak-model` / `/weak-model`
*"Specify the model to use for commit messages and chat history summarization."* Used for:
- **Git commit messages** — Aider sends the weak model a copy of the diff + chat history and asks for a commit message.
- **Chat-history summarization** — when the conversation grows long, the weak model condenses older turns to keep the context small (a cost-control move in itself).

A cheap model is plenty here because these are low-stakes, well-bounded NLP tasks unrelated to code correctness. Default depends on the main model (e.g. with a Claude main model, the weak model defaults to a Haiku-class model).

**Why this matters for cost:** the expensive model only handles the genuinely hard reasoning step. Commit messages and summaries — which can fire on *every* edit — never touch the premium model.

---

## 3. Edit formats

Aider supports several "edit formats" — the protocol the LLM uses to express file changes. **Different models are reliable with different formats**, and Aider picks the best one per model automatically. Override with `--edit-format` (main) or `--editor-edit-format` (editor).

| Format | What the LLM returns | Best for / notes |
|--------|----------------------|------------------|
| **whole** | Full updated copy of each changed file | Simplest, most reliable for weaker models. Slow + costly: re-emits the entire file even for a 1-line change. Used by gpt-4o-mini, o1-mini-as-editor. |
| **diff** | Search/replace blocks (git-merge-conflict style) | Token-efficient — only changed regions are emitted. Default for strong models (Sonnet, gpt-4o). |
| **diff-fenced** | Like `diff` but the file path goes *inside* the fence | Built for the **Gemini** family, which mishandles standard diff fencing. |
| **udiff** | Simplified unified-diff | Created to fight **GPT-4 Turbo's "lazy coding"** (eliding code with `# ... rest unchanged` placeholders); reduces elisions. See "Unified diffs make GPT-4 Turbo 3X less lazy." |
| **editor-diff** | `diff` with a stripped-down, edit-only prompt | Recommended editor format in architect mode — prompt focuses purely on formatting, not problem-solving. |
| **editor-whole** | `whole` with the edit-only prompt | Recommended editor format for weaker editor models. |
| **editor-diff-fenced** | `diff-fenced` editor variant | Gemini editor models. |
| **architect** | (meta-format) triggers the 2-request architect/editor flow | Selected by `--architect`. |

### How format is matched to model
- Aider ships **per-model defaults** so each known model uses the format it's most reliable with (`edit_format` / `editor_edit_format` keys in model settings).
- The **core tradeoff**: `whole` = maximum reliability but maximum tokens/cost; `diff`/`udiff` = far fewer output tokens but require a model disciplined enough to produce valid diffs. Aider gives stronger models the cheaper diff formats and falls back to `whole` for weaker ones.
- The `editor-*` variants exist specifically so an editor model gets a lean prompt (no problem-solving instructions), improving formatting compliance — R1+Sonnet hit **100% edit-format compliance**.

---

## 4. Repo map

The repo map is *"a concise map of your whole git repository"* — a way to give the model whole-codebase awareness **without** pasting whole files.

### How it's built (tree-sitter + graph ranking)
1. **Parse** every source file with **tree-sitter** (via `py-tree-sitter-languages`, pip-installable binary wheels) into an AST. From the AST, Aider locates every **definition** (functions, classes, variables, types) and every **reference** to those symbols.
2. **Build a dependency graph**: each source file is a node; edges connect files that reference each other's symbols.
3. **Rank** with a **graph ranking algorithm** (PageRank-style over the definition/reference graph) to find the *most-referenced, most-central* identifiers — the symbols the model most needs to understand the codebase.
4. **Emit** file paths + key symbol signatures (not full bodies), e.g. class/method signatures and the critical defining lines.

### Token budgeting
- `--map-tokens N` — suggested token budget for the map (use `0` to disable). Aider selects the highest-ranked symbols that fit the budget.
- `--map-multiplier-no-files` (default **2**) — when **no files have been added to the chat**, Aider *expands* the map (multiplies the budget) so the model gets more whole-repo context to figure out where to work. Once files are added, the map shrinks back.
- `--map-refresh` (default **auto**; options `auto`, `always`, `files`, `manual`) — controls how often the (relatively expensive) map is recomputed.
- The map **resizes dynamically** based on chat state, generally staying near the configured budget.

### How it reduces context cost
Instead of stuffing entire files (or the whole repo) into context, the model sees a **ranked signature-level summary** — enough to know *what exists and how it connects*, at a tiny fraction of the tokens. The model then asks for specific files when it needs full bodies. This is the central trick for working in large repos within a limited (and billed-per-token) context window.

---

## 5. Prompt caching

Aider supports provider-side **prompt caching** to avoid re-paying for the large, static prefix of each request.

- **Enable:** `--cache-prompts` (default `False`; env `AIDER_CACHE_PROMPTS`).
- **Supported providers:** **Anthropic** (Sonnet, Haiku) and **DeepSeek** (Chat).
- **What gets cached** (Aider structures the message so the stable prefix is cacheable):
  1. The system prompt
  2. Read-only files (`--read` / `/read-only`)
  3. The repository map
  4. Editable files added to the conversation
- **Keepalive:** `--cache-keepalive-pings N` (default `0`). Anthropic expires cache after **5 minutes**; with this flag Aider *"will ping up to N times over a period of N×5 minutes after each message,"* keeping the cache warm during think time.
- **Caveat:** cache hit/cost stats aren't reported while streaming — use `--no-stream` to see them.

**Cost implication:** the system prompt + repo map + read-only files are large and *identical across turns*. Caching them means you pay full price once and a steep discount on every subsequent turn (Anthropic: cache reads ~10% of input price), so it pairs especially well with a big repo map and read-only convention files.

---

## 6. Model routing / auto-selection & config

Aider does **not** do dynamic per-request routing (it won't pick a model mid-task), but it has rich **static auto-configuration** so that naming one model auto-derives the rest.

### Built-in per-model defaults
For known models (Claude, GPT, Gemini, DeepSeek, …) Aider ships defaults for: `edit_format`, `editor_model_name`, `editor_edit_format`, `weak_model_name`, `use_repo_map`, caching, temperature, streaming, system-prompt usage. So `--model claude-3-5-sonnet` automatically sets a sensible editor model, weak model, and `diff` edit format with no extra config.

### `.aider.model.settings.yml` (per-model behavior, for unknown models)
Searched in home dir, git root, and cwd (later wins); override with `--model-settings-file`.
```yaml
- name: deepseek/deepseek-chat
  edit_format: diff
  weak_model_name: deepseek/deepseek-chat
  editor_model_name: deepseek/deepseek-chat
  editor_edit_format: editor-diff
  use_repo_map: true
  cache_control: true
  use_temperature: true
  streaming: true
  extra_params:
    max_tokens: 8192
# special: apply to ALL models
- name: aider/extra_params
  extra_params:
    extra_headers:
      Custom-Header: value
```

### `.aider.model.metadata.json` (token limits & pricing, for unknown models)
Override with `--model-metadata-file`. Lets Aider compute cost/context for models LiteLLM doesn't know:
```json
{
  "deepseek/deepseek-chat": {
    "max_input_tokens": 32000,
    "max_output_tokens": 4096,
    "input_cost_per_token": 0.00000014,
    "output_cost_per_token": 0.00000028,
    "litellm_provider": "deepseek",
    "mode": "chat"
  }
}
```
Pricing here is what powers Aider's live in-chat cost tracking.

### `.aider.conf.yml` (session config) + model aliases
Searched home → git root → cwd (later wins); override with `--config`.
```yaml
model: claude-3-5-sonnet-20241022
weak-model: claude-3-5-haiku-20241022
editor-model: claude-3-5-haiku-20241022
edit-format: diff
editor-edit-format: editor-diff
cache-prompts: true
map-tokens: 1024
alias:
  - "fast=gpt-4o-mini"
  - "powerful=claude-3-opus-20240229"
```
Aliases (`--alias name=model` or the `alias:` list) give short handles, e.g. `aider --model fast`. Built-in aliases like `sonnet`/`opus` are kept current (updated to Sonnet 4 / Opus 4 series).

---

## 7. Concrete cost / performance tradeoffs Aider publishes

- **R1 (architect) + Sonnet (editor): 64.0% polyglot @ $13.29** vs **o1 alone: 61.7% @ $186.50** → higher score at **~14× lower cost** and 100% edit-format compliance.
- **Architect/editor beats single-model baselines** across the board on the code-editing benchmark (o1-mini 61.1%→71.4%, gpt-4o 71.4%→75.2%, Sonnet 77.4%→80.5%).
- **`whole` vs `diff`:** `whole` formats reached the 85% SOTA but were *"quite slow, probably not practical for interactive use"* because they re-emit entire files — a direct latency/token cost for accuracy.
- **`udiff` made GPT-4 Turbo "3X less lazy,"** i.e. choosing the right edit format materially changed output quality and reduced wasted/incomplete edits.
- **Two-request cost:** architect mode explicitly *"uses two LLM requests, which can take longer and increase costs"* — the tradeoff you accept for reasoning-heavy tasks.
- **Repo map vs full files:** sending ranked signatures instead of whole files is *"more efficient than sending entire files"* and is what makes large repos tractable within a token budget.
- **Caching:** caches system prompt + repo map + read-only files + editable files for *"cost savings and faster coding"* on Anthropic/DeepSeek; keepalive pings trade a few cheap requests to avoid losing the cache between human turns.

---

## Sources
- [Separating code reasoning and editing (architect post)](https://aider.chat/2024/09/26/architect.html)
- [Chat modes](https://aider.chat/docs/usage/modes.html)
- [Edit formats](https://aider.chat/docs/more/edit-formats.html)
- [Unified diffs make GPT-4 Turbo 3X less lazy](https://aider.chat/docs/unified-diffs.html)
- [QwQ is a code architect, not an editor](https://aider.chat/2024/12/03/qwq.html)
- [R1+Sonnet set SOTA on aider's polyglot benchmark](https://aider.chat/2025/01/24/r1-sonnet.html)
- [Repository map (docs)](https://aider.chat/docs/repomap.html)
- [Building a better repository map with tree sitter](https://aider.chat/2023/10/22/repomap.html)
- [Prompt caching](https://aider.chat/docs/usage/caching.html)
- [Advanced model settings](https://aider.chat/docs/config/adv-model-settings.html)
- [Options reference (all flags & defaults)](https://aider.chat/docs/config/options.html)
- [YAML config file (.aider.conf.yml)](https://aider.chat/docs/config/aider_conf.html)
- [Model aliases](https://aider.chat/docs/config/model-aliases.html)
- [Code editing leaderboard](https://aider.chat/docs/leaderboards/edit.html)
- [In-chat commands](https://aider.chat/docs/usage/commands.html)
