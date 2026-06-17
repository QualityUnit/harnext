# Continue.dev Model Roles & the "Fast Apply" Pattern

*Research note — multi-model usage in IDE coding agents, with a focus on Continue.dev's
role system and the broader industry pattern of cheap specialized models (autocomplete,
apply, embed, rerank). Compiled for harness-engineering reference.*

Primary sources are cited inline as URLs and collected at the end.

---

## 0. TL;DR

Continue.dev does **not** use one model for everything. It splits work into six
**roles** — `chat`, `edit`, `apply`, `autocomplete`, `embed`, `rerank` — and lets you bind a
*different* model to each in a single `config.yaml`. The guiding principle is **right-sized
models per task**: a frontier model for reasoning-heavy chat/edit, a tiny FIM model for
autocomplete, a specialized "fast apply" model to materialize edits, and small embedding/rerank
models for codebase RAG. This is the same architecture Cursor, Morph, Relace, and Fireworks
converge on: **a big model proposes; a cheap fast model executes.**

---

## 1. Model Roles in Continue

A "role" is a job a model can fulfill. In `config.yaml` each model block declares a `roles:`
array, and a model may serve multiple roles. You then pick the active model per role in the IDE.

Source: <https://docs.continue.dev/customize/model-roles/00-intro>

| Role | What it does (verbatim intent) | Appropriate model class |
|------|--------------------------------|--------------------------|
| **chat** | "Used for chat conversations in the extension sidebar." Conversational, reasoning-heavy, tool-calling. | Largest / frontier (Claude Sonnet/Opus, GPT-5, Gemini 2.5 Pro). High cost, high latency tolerated. |
| **edit** | "Used to generate code based on edit prompts." Code-specific edits to a selected region. Falls back to the chat model if unset. | Strong code model; closed & open perform similarly (Claude Sonnet 4.6, GPT-5, Qwen3 Coder 480B/30B). |
| **apply** | "Used to decide how to apply edits to a file." Turns a proposed/lazy edit into a concrete diff against the real file. | **Specialized fast-apply model** (Morph, Relace) or a cheap chat model (Claude 3.5 Haiku). Latency-critical. |
| **autocomplete** | "Used for autocomplete code suggestions in the editor." Inline, as-you-type completion via FIM. | **Tiny fast FIM model** (Qwen2.5-Coder 1.5B/7B, Codestral, Mercury Coder). Sub-second latency mandatory. |
| **embed** | "Used to generate embeddings used for vector search (`@Codebase` and `@Docs`)." | Small embedding model — "typically much smaller than LLMs … extremely fast and cheap" (voyage-code-3, nomic-embed-text). |
| **rerank** | "Used to rerank results from vector search." Scores (query, snippet) → 0..1. | Small cross-encoder reranker (voyage rerank-2, Cohere rerank-english-v3.0). Smaller/faster than an LLM. |

(There is also a `summarize` role mentioned in the YAML reference, used to compress context;
it is not a primary focus here.)

The key conceptual point: **roles decouple "what task" from "which model,"** so the harness can
route each subtask to the cheapest model that meets that task's quality/latency bar.

Sources:
- <https://docs.continue.dev/customize/model-roles>
- <https://docs.continue.dev/reference> (config.yaml reference)

---

## 2. The `autocomplete` Role — tiny FIM models

### What it is
Autocomplete provides inline, ghost-text suggestions while you type. It is powered by a model
trained on **fill-in-the-middle (FIM)**: a format where the model is given the **prefix**
(code before the cursor) and **suffix** (code after the cursor) and must predict the text that
goes *between* them. This is fundamentally different from left-to-right chat generation.

Source: <https://docs.continue.dev/customize/model-roles/autocomplete>

### Why a small fast model
The docs are explicit: because the task is "highly specialized," autocomplete models can be
**much smaller than chat models** — "even a 3B parameter model can perform well," while large
chat models "typically underperform despite their size." Closed models (Codestral, Mercury Coder)
are noted as "slightly better than open models," but open 1.5B–7B models are entirely viable.

Recommended models:
- Open source: **Qwen2.5-Coder 1.5B / 7B**
- Closed: **Codestral**, **Mercury Coder**
- Other FIM-capable families Continue supports: CodeGemma, CodeLlama, DeepSeek Coder, StarCoder, CodeGeeX

### Latency budget
Autocomplete is the most latency-sensitive role: it must return before the user keeps typing.
Continue exposes `autocompleteOptions` to manage this budget:

| Field | Default | Purpose |
|-------|---------|---------|
| `debounceDelay` | `250` (ms) | Wait after last keystroke before firing — avoids spamming the model. |
| `modelTimeout` | `150` (ms) | Hard cap on model response; drop the completion if it's slower. |
| `maxPromptTokens` | `1024` | Keep the prompt tiny so prefill is fast. |
| `prefixPercentage` | `0.3` | Fraction of the budget given to code before the cursor. |
| `maxSuffixPercentage` | `0.2` | Cap on the code-after-cursor portion. |
| `onlyMyCode` | `true` | Restrict context to the user's repo. |
| `disable` | `false` | Toggle. |

The combination of a **tiny model + tiny prompt (≤1024 tokens) + 150 ms timeout + 250 ms
debounce** is the whole latency strategy. A frontier model simply cannot hit a 150 ms budget,
which is the structural reason autocomplete *must* use a different model than chat.

### FIM prompt templating
Continue lets you override the FIM template per model with Handlebars variables:
`{{{prefix}}}`, `{{{suffix}}}`, `{{{filename}}}`, `{{{reponame}}}`, `{{{language}}}`.

```yaml
models:
  - name: Codestral
    provider: mistral
    model: codestral-latest
    roles:
      - autocomplete
    autocompleteOptions:
      disable: false
      maxPromptTokens: 1024
      debounceDelay: 250
      modelTimeout: 150
      maxSuffixPercentage: 0.2
      prefixPercentage: 0.3
      onlyMyCode: true

  # Local tiny model with an explicit FIM template (Qwen FIM tokens)
  - name: Qwen FIM (local)
    provider: ollama
    model: qwen2.5-coder:1.5b
    roles:
      - autocomplete
    promptTemplates:
      autocomplete: |
        <|fim_prefix|>{{{prefix}}}<|fim_suffix|>{{{suffix}}}<|fim_middle|>
```

Note the model-specific FIM control tokens (`<|fim_prefix|>`, `<|fim_suffix|>`,
`<|fim_middle|>`). Different model families use different tokens; getting them wrong produces
"garbage" completions (a recurring issue in Continue's tracker, e.g. self-hosted Qwen on vLLM).

Sources:
- <https://docs.continue.dev/customize/model-roles/autocomplete>
- <https://docs.continue.dev/customize/deep-dives/autocomplete>

---

## 3. The `apply` Role — instant/fast-apply models

### The problem it solves
When a chat/edit model proposes a change, its output is usually a **partial or "lazy" edit** —
a snippet with `// ... existing code ...` markers, or a code block that doesn't line up exactly
with the file on disk. Naively, you'd ask the big model to **rewrite the entire file** to apply
the change, which is slow and expensive. The `apply` role exists to do this final
"materialize the edit into the actual file" step cheaply.

Continue's description: apply is "used to decide how to apply edits to a file." Architecturally
it **compares the original code against the proposed new code and generates a diff** that bridges
them, so the change "integrates smoothly with existing code structures."

Source: <https://docs.continue.dev/customize/model-roles/apply>

### Two-stage architecture (the central pattern)

```
  ┌─────────────────────┐      lazy / sketch edit      ┌──────────────────────┐
  │  PLANNING MODEL      │   (snippet + "...existing    │  APPLY MODEL         │
  │  (frontier: Claude,  │ ───  code..." markers)  ───▶ │  (cheap, fast,       │
  │   GPT, Gemini)       │                              │   specialized 7B)    │
  │  decides WHAT to do  │                              │  materializes the    │
  └─────────────────────┘                              │  full edited file    │
                                                        └──────────────────────┘
        expensive, smart                                    cheap, blazing fast
```

The expensive model reasons about *what* to change; the cheap specialized model does the
mechanical *merge* into the real file. Because merging is a narrow, well-defined task, a small
model fine-tuned on it can run **~100x faster than a general-purpose model** (Morph's framing)
while matching or beating frontier accuracy on the merge itself.

### Recommended apply models
- **Morph Fast Apply** (`morph-v2`, current; `morph-v0` legacy)
- **Relace Instant Apply** (`relace-apply-3`)
- Budget fallback: a small chat model like **Claude 3.5 Haiku**

### Config — Morph as the apply model
Morph is OpenAI-API-compatible, so it's configured as an `openai` provider with a custom base URL:

```yaml
name: My Config
version: 0.0.1
schema: v1

models:
  - name: Morph Fast Apply
    provider: openai
    model: morph-v2
    apiKey: <YOUR_MORPH_API_KEY>
    apiBase: https://api.morphllm.com/v1/
    roles:
      - apply
    promptTemplates:
      apply: "<code>{{{ original_code }}}</code>\n<update>{{{ new_code }}}</update>"
```

The apply prompt template exposes exactly two variables: `{{{original_code}}}` (the file as it
is) and `{{{new_code}}}` (the proposed lazy edit). Morph's wire format wraps these in `<code>`
and `<update>` tags; Relace uses a similar `<instruction>/<code>/<update>` convention.

Sources:
- <https://docs.continue.dev/customize/model-roles/apply>
- <https://docs.continue.dev/customize/model-providers/more/morph>

---

## 4. `embed` and `rerank` Roles — cheap models for codebase RAG

Continue's `@Codebase` / `@Docs` features do **retrieval-augmented generation over the repo**.
Two cheap model classes power this, neither of which is an LLM.

### Retrieval pipeline
1. **Index** the codebase by chunking files and computing **embeddings** (the `embed` model).
2. At query time, do **vector similarity search** to pull ~50 candidate chunks.
3. Send all candidates + the query to the **reranker** (the `rerank` model), which scores each
   (query, chunk) pair 0..1 and keeps the most relevant.
4. Feed the top chunks to the chat model as context.

The split exists because vector search is cheap-but-fuzzy (recall) and reranking is a precise
cross-encoder (precision). Doing precise scoring on all chunks would be too slow; doing only
vector search would be too imprecise. Retrieve-many-then-rerank-few is the standard RAG shape.

Sources:
- <https://docs.continue.dev/customize/model-roles/embeddings>
- <https://docs.continue.dev/customize/model-roles/reranking>
- <https://docs.continue.dev/guides/custom-code-rag>

### embed
Embedding models "are typically much smaller than LLMs, and will be extremely fast and cheap in
comparison." Recommendations:
- **voyage-code-3** (commercial, code-specialized — the top pick "if you can use any model")
- **nomic-embed-text** via Ollama (local/open)
- **transformers.js** `all-MiniLM-L6-v2` built into the VS Code extension (zero-config local)

```yaml
models:
  - name: Voyage Code 3
    provider: voyage
    model: voyage-code-3
    apiKey: <YOUR_VOYAGE_API_KEY>
    roles:
      - embed

  # Fully local, no API key
  - name: Nomic Embed (local)
    provider: ollama
    model: nomic-embed-text
    roles:
      - embed
```

### rerank
A reranker "accepts two text inputs (a question and a document) and returns a relevancy score
between 0 and 1." These models "are smaller and faster than LLMs." Recommendations:
- **voyage rerank-2** (top pick for code)
- **Cohere rerank-english-v3.0**
- Fallback: an LLM (works, but "sacrifices both cost-efficiency and accuracy")

```yaml
models:
  - name: Voyage Reranker
    provider: voyage
    model: rerank-2
    apiKey: <YOUR_VOYAGE_API_KEY>
    roles:
      - rerank

  - name: Cohere Reranker
    provider: cohere
    model: rerank-english-v3.0
    apiKey: <YOUR_COHERE_API_KEY>
    roles:
      - rerank
```

(Relace also publishes a code-specialized embed+rerank stack, underscoring that retrieval is
itself a specialized-model market — <https://relace.ai/blog/code-retrieval>.)

---

## 5. Full multi-role `config.yaml` example

This is the payoff of the role system — one config, six models, each right-sized:

```yaml
name: Multi-Role Setup
version: 0.0.1
schema: v1

models:
  # Reasoning-heavy: chat + edit on a frontier model
  - name: Claude Sonnet 4.6
    provider: anthropic
    model: claude-sonnet-4-6
    apiKey: <ANTHROPIC_API_KEY>
    roles:
      - chat
      - edit

  # Inline completion: tiny FIM model, tight latency budget
  - name: Codestral
    provider: mistral
    model: codestral-latest
    apiKey: <MISTRAL_API_KEY>
    roles:
      - autocomplete
    autocompleteOptions:
      maxPromptTokens: 1024
      debounceDelay: 250
      modelTimeout: 150

  # Materialize edits: specialized fast-apply model
  - name: Morph Fast Apply
    provider: openai
    model: morph-v2
    apiKey: <MORPH_API_KEY>
    apiBase: https://api.morphllm.com/v1/
    roles:
      - apply
    promptTemplates:
      apply: "<code>{{{ original_code }}}</code>\n<update>{{{ new_code }}}</update>"

  # Codebase RAG: small embed + small rerank
  - name: Voyage Code 3
    provider: voyage
    model: voyage-code-3
    apiKey: <VOYAGE_API_KEY>
    roles:
      - embed

  - name: Voyage Reranker
    provider: voyage
    model: rerank-2
    apiKey: <VOYAGE_API_KEY>
    roles:
      - rerank
```

Source for schema/shape: <https://docs.continue.dev/reference>

---

## 6. Cost / latency reasoning per role

| Role | Latency requirement | Cost profile | Why this model class |
|------|--------------------|--------------|----------------------|
| chat | Seconds OK (user is reading) | Highest per-token; lowest call volume | Needs reasoning + tool use; quality dominates. |
| edit | Seconds OK | High, but bounded by selection size | Code quality matters; a strong model avoids retries. |
| apply | **Must feel instant** (<1–2 s for whole file) | Very low per edit (700–1,400 tok vs 3,500–4,500 for a rewrite) | Mechanical merge — a 7B specialist at 10k tok/s beats a frontier rewrite on speed *and* cost. |
| autocomplete | **<150–300 ms** | Lowest per call, **highest call volume** | Fires on every keystroke; only a tiny model + tiny prompt can keep up affordably. |
| embed | Batch / background (indexing) | Tiny per chunk; volume = repo size | Not an LLM; throughput over reasoning. |
| rerank | ~100 ms over ~50 candidates | Cheap cross-encoder | Precision filter; LLM here is wasteful. |

The unifying insight: **call volume and latency requirements are inversely correlated with
model size.** The roles you invoke most often (autocomplete, apply, embed) are exactly the ones
where a small specialized model wins on every axis — latency, throughput, and dollars — while
the rare, hard reasoning steps (chat/edit) justify a frontier model.

---

## 7. The industry "fast apply" pattern (Morph, Relace, Cursor, Fireworks)

Continue's `apply` role is one instance of a now-standard architecture. Every major player has
independently converged on **"big model proposes a lazy/sketch edit; a cheap specialized model
materializes the full file fast."**

### Cursor — Instant Apply / speculative edits
- Splits editing into **planning** (frontier model in chat) and **applying** (specialized model).
- Deliberately uses **full-file rewrite, not diffs**, for files under ~400 lines, because:
  1. More output tokens = more forward passes = more "thinking room";
  2. Diffs are out-of-distribution vs. pretraining (which is full files);
  3. Models output wrong line numbers in diff formats (tokenizer treats number runs oddly).
- Invented **"speculative edits"**: a speculative-decoding variant that, instead of a draft model,
  **speculates deterministically from the existing file** (strong prior: the output mostly equals
  the input). Validated greedily — the server keeps the longest prefix of the speculation that
  matches temperature=0 generation, then resumes normal decoding.
- Result on a fine-tuned **Llama-3-70B**: **~1000 tok/s (~3500 char/s)**, a **~13x speedup** over
  vanilla 70B inference and **~9x** over their prior GPT-4 speculative deployment.
- Sources: <https://cursor.com/blog/instant-apply>, <https://fireworks.ai/blog/cursor>

### Morph — Fast Apply
- Standalone fast-apply API. **~10,500 tok/s at ~98% merge accuracy.**
- A **1,000-line file edits in ~1.3 s** vs **10–12 s** for a full-file rewrite by a frontier model.
- **700–1,400 tokens per edit** vs **3,500–4,500** for a rewrite → **50–60% fewer tokens**, **90%+
  less latency**.
- Accepts the **lazy edit format** — the *default* output of Claude/GPT/most coding models — keyed
  on the `// ... existing code ...` marker meaning "preserve the original here."
- Framing: "Code merging is a well-defined task… a smaller model trained specifically on this task
  runs **100x faster** than a general-purpose model." Claims ~100% merge success when paired with a
  frontier planner, vs 84–96% for search-and-replace (which forces costly retry loops).
- Sources: <https://www.morphllm.com/fast-apply-model>, <https://docs.morphllm.com/sdk/components/fast-apply>

### Relace — Instant Apply
- **`relace-apply-3`**, deployed with an optimized speculative-decoding algorithm.
- **>10,000 tok/s** (averaging ~4,300 tok/s in earlier reports), **~96% accuracy**.
- Claims **40x faster than Claude 4 Sonnet** and **14x faster than GPT-4o-mini predictive edits**.
- Trained on `(initial code, lazy edit snippet, correctly merged final code)` across dozens of
  languages. Also ships a code embed+rerank retrieval stack.
- Sources: <https://www.relace.ai/blog/instant-apply>, <https://relace.ai/blog/relace-apply-3>

### Fireworks — Speculative Decoding API
- The inference primitive Cursor built on. Caller supplies a **prediction** of the output; the
  server **validates it deterministically** (longest prefix match at temperature=0), consuming
  many tokens per forward pass when the prediction is right.
- This is *the* enabling trick: code edits have a strong prior (output ≈ input), so deterministic
  speculation is far more effective than a draft model.
- Source: <https://fireworks.ai/blog/cursor>

### Common thread
| | Planner (proposes) | Applier (materializes) |
|---|---|---|
| Model | Frontier (Claude/GPT/Gemini) | Small specialist (7B–70B fine-tune) |
| Output | Lazy edit w/ `... existing code ...` | Full edited file |
| Optimization | Reasoning quality | Speculative decoding from the original file |
| Cost/latency | High, low volume | ~100x cheaper/faster, high volume |

The lazy-edit format is the interface contract that makes this composable: any frontier model can
emit it, and any fast-apply model can consume it.

---

## 8. Transferable design principles for a model-agnostic harness

1. **Adopt a role abstraction.** Decouple *task* from *model*. Define named roles
   (`chat`, `edit`, `apply`, `autocomplete`, `embed`, `rerank`) and let config bind any
   provider/model to each — exactly Continue's `roles:` array. The harness routes, the user chooses.

2. **Right-size by call volume × latency.** The highest-frequency, lowest-latency operations
   (autocomplete, apply, embed) should target the smallest specialized model that clears the bar;
   reserve frontier models for the rare hard reasoning steps. Cost scales with volume, not difficulty.

3. **Make "lazy edit + fast apply" a first-class path.** Have the planning model emit a lazy edit
   (`// ... existing code ...` convention) and route materialization to a cheap apply model
   (Morph/Relace via OpenAI-compatible endpoints), with a small-chat-model fallback. Cuts tokens
   ~50–60% and latency ~90% vs. full-file rewrites.

4. **Use FIM + tight budgets for completion, and retrieve-many-then-rerank for codebase context.**
   Autocomplete needs a tiny FIM model with model-specific tokens, a ≤1024-token prompt, debounce,
   and a hard timeout. RAG needs a small embed model for recall and a small reranker for precision —
   neither should be an LLM.

5. **Keep the wire formats provider-neutral.** Per-role prompt templates (Handlebars variables like
   `prefix`/`suffix`/`original_code`/`new_code`) and OpenAI-compatible base URLs let one config span
   Anthropic, Mistral, Voyage, Morph, Ollama, etc. without code changes — the core of being
   model-agnostic.

---

## Sources

**Continue.dev (primary docs)**
- Intro to roles — <https://docs.continue.dev/customize/model-roles/00-intro>
- Model roles index — <https://docs.continue.dev/customize/model-roles>
- Autocomplete role — <https://docs.continue.dev/customize/model-roles/autocomplete>
- Autocomplete deep dive — <https://docs.continue.dev/customize/deep-dives/autocomplete>
- Edit role — <https://docs.continue.dev/customize/model-roles/edit>
- Apply role — <https://docs.continue.dev/customize/model-roles/apply>
- Embed role — <https://docs.continue.dev/customize/model-roles/embeddings>
- Rerank role — <https://docs.continue.dev/customize/model-roles/reranking>
- Morph provider — <https://docs.continue.dev/customize/model-providers/more/morph>
- Custom code RAG — <https://docs.continue.dev/guides/custom-code-rag>
- config.yaml reference — <https://docs.continue.dev/reference>

**Fast-apply industry (primary)**
- Cursor — Editing Files at 1000 Tokens/Second — <https://cursor.com/blog/instant-apply>
- Fireworks — How Cursor built Fast Apply (Speculative Decoding API) — <https://fireworks.ai/blog/cursor>
- Morph — Fast Apply model — <https://www.morphllm.com/fast-apply-model>
- Morph — Fast Apply SDK docs — <https://docs.morphllm.com/sdk/components/fast-apply>
- Relace — Instant Apply (4300 tok/s) — <https://www.relace.ai/blog/instant-apply>
- Relace — Apply 3 / path to 10k tok/s — <https://relace.ai/blog/relace-apply-3>
- Relace — Code retrieval (embed + rerank) — <https://relace.ai/blog/code-retrieval>
- Relace Instant Apply on Continue hub — <https://hub.continue.dev/relace/instant-apply>
