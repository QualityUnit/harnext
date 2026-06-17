# Model Routing, Cascades & Cost Reduction for Coding Agents

> A technical survey of the general techniques, research, and frameworks for LLM
> routing, cascading, and cost reduction — and how they map onto a model-agnostic
> coding-agent harness. Numbers and mechanisms are drawn from primary sources
> (arXiv papers, provider docs, vendor blogs) cited inline.

**Two complementary cost paradigms frame this whole document:**

- **Routing** — pick the right model *before* generation, per query. Spend a tiny
  classifier cost up front, commit to one model. Best when difficulty is
  cheaply predictable and you need bounded latency.
- **Cascading** — try the cheapest model *first*, then run a verifier/confidence
  check; escalate to a more expensive model only on failure. Spend nothing up
  front but may pay for multiple generations on hard queries. Best when a cheap,
  reliable verifier exists and the cheap model handles most traffic.

Everything else here (caching, speculative decoding, ensembling, reasoning
budgets, semantic caching) is an orthogonal lever you can stack on top of either.

---

## 1. LLM Routing

General framing: a lightweight **router** sits in front of a **strong/expensive**
model and a **weak/cheap** model and decides per-query where to send the request.
The decision reduces to **win-rate prediction** — estimate P(strong model produces
a meaningfully better answer than weak model | this query). If that probability is
below a cost-tuned threshold, route cheap. The art is the query classifier.

### 1.1 RouteLLM (LMSYS / UC Berkeley) — arXiv 2406.18665

Source: <https://arxiv.org/abs/2406.18665> (Ong et al., ICLR 2025) ·
code: <https://github.com/lm-sys/RouteLLM>

- **Setup:** routes between a **strong model = GPT-4** (`gpt-4-1106-preview`) and a
  **weak model = Mixtral-8x7B**. Trained on **~80,000 human preference battles
  from Chatbot Arena**, augmented with golden-label and LLM-judge data.
- **Mechanism:** decompose into (1) a **win-prediction model** estimating
  P(strong wins | query), and (2) a **cost threshold** converting that probability
  into a binary route. Sweeping the threshold traces the cost/quality frontier.
- **Four router classifiers:**
  1. **Similarity-weighted (SW) ranking** — weighted Bradley-Terry/Elo where
     training battles are weighted by embedding similarity to the incoming prompt
     (non-parametric, retrieval-style).
  2. **Matrix factorization (`mf`)** — low-rank bilinear scorer over (model, query)
     embeddings. **Recommended / best-performing.**
  3. **BERT classifier** — BERT encoder fine-tuned to predict the win label from
     prompt text.
  4. **Causal LLM classifier** — instruction-tuned causal LLM emitting win/loss as
     next-token prediction.
- **Headline numbers:** reaches **95% of GPT-4 performance** while routing far
  fewer queries to GPT-4:
  - **Up to ~85% cost reduction on MT-Bench** at 95% GPT-4 performance.
  - vs. a **random router** baseline: **>2× cheaper on MT-Bench, ~1.9× on MMLU,
    ~1.4× on GSM8K** at equal quality. (MMLU is harder to route on → smaller gain.)
  - **>40% cheaper** than commercial offerings at matched performance.
- **Metrics introduced** (useful vocabulary for any harness eval):
  - **PGR (Performance Gap Recovered)** — fraction of the weak→strong quality gap
    recovered at a given cost.
  - **APGR (Average PGR)** — PGR averaged over the cost axis (area under the
    cost–quality curve); single-number router quality.
  - **CPT(x%) (Call-Performance Threshold)** — % of calls that must go to the
    strong model to achieve x% PGR. Lower is better.
- **Transfer learning (key for model-agnostic use):** routers trained on
  GPT-4/Mixtral **generalize** to a different strong/weak pair (e.g. Claude/Llama)
  at test time without retraining, because they learn query *difficulty*, not
  model-specific quirks.

### 1.2 Commercial routers

All implement the same loop (classify query → predict per-model quality → pick
under a cost/quality tradeoff); they differ in *how* the classifier is built and
how much is disclosed.

- **Martian** (<https://martian.ai>) — classifies prompt *difficulty* in real time,
  routes easy → cheap (e.g. Haiku-class) and hard → expensive (Opus-class). Built
  on proprietary **"Model Mapping"** (claimed first commercial application of
  mechanistic interpretability). Vendor framing: **40–70% cost savings with <2%
  quality loss**.
  [Accenture coverage](https://newsroom.accenture.com/news/2024/accenture-invests-in-martian-to-bring-dynamic-routing-of-large-language-queries-and-more-effective-ai-systems-to-clients)
- **OpenRouter "Auto Router"** (`openrouter/auto`) — **powered by NotDiamond.**
  Analyzes complexity/task-type/requirements, routes among dozens of models.
  Exposes a **`cost_quality_tradeoff` dial 0–10 (default 7)** (0 = always most
  capable, 10 = always cheapest), `allowed_models` to constrain the pool, and
  **sticky routing** that pins the chosen model for a conversation to maximize
  prompt-cache hits. **No routing surcharge** — you pay the selected model's rate.
  [docs](https://openrouter.ai/docs/guides/routing/routers/auto-router)
- **NotDiamond** (<https://www.notdiamond.ai>) — trains a **"meta-model"** that
  learns per-query which LLM performs best (predictive, data-driven). Vendor
  numbers: **5–20% accuracy gain over the best single model**; **+39% on SRE
  benchmarks**; cost savings **20–95%**. *Independent caveat:* the
  [RouterArena benchmark (arXiv 2510.00202)](https://arxiv.org/html/2510.00202v3)
  ranks it **#12** on cost-efficiency, noting it often picks expensive models.
- **Unify (unify.ai)** — a **proprietary neural quality scorer** predicts each
  model's output quality, combined with **live runtime benchmarks** of endpoint
  cost/speed (refreshed ~every 10 min). Users steer with **three sliders: quality,
  cost, latency.** Predicts quality *before* routing rather than just
  load-balancing.
- **Portkey** — **rule-based, NOT ML query-classification.** It is an AI gateway:
  **conditional routing** on metadata / request params / URL path (you write the
  rules), and **weighted load balancing** + retries/failover. The operational
  counterpart to ML routers — policy/observability-driven, not difficulty-driven.
  [conditional routing docs](https://portkey.ai/docs/product/ai-gateway/conditional-routing)

---

## 2. Model Cascades / FrugalGPT

Cascade framing: run the cheapest model first, apply a **verifier / confidence
check**, escalate to the next (more expensive) model only on failure. Cascades
can *exceed* the best single model's accuracy because different models cover
different queries.

### 2.1 FrugalGPT (Chen, Zaharia, Zou) — arXiv 2305.05176

Source: <https://arxiv.org/abs/2305.05176> ·
HTML: <https://ar5iv.labs.arxiv.org/html/2305.05176>

- **Cost context:** API prices span **two orders of magnitude** — GPT-J ≈ $0.2/10M
  tokens vs GPT-4 ≈ $30 for comparable volume.
- **Three strategies:** (1) **prompt adaptation** (selective few-shot + query
  concatenation), (2) **LLM approximation** (completion caching + fine-tuning a
  small model on an expensive model's outputs), (3) the headline **LLM cascade.**
- **Cascade mechanism — two components:**
  - A **generation scoring function** — a regression model (FrugalGPT uses a
    **DistilBERT fine-tuned for regression**) producing a **reliability score in
    [0,1]** for an (query, answer) pair, estimating correctness *without* calling
    a bigger model.
  - A **per-model confidence threshold.** Queries flow through an ordered list of
    LLMs; if the score exceeds that stage's threshold the cascade **terminates
    early**; else it escalates. Both **ordering and thresholds are learned** under
    a cost budget. (Worked example on HEADLINES:
    **GPT-J@0.96 → J1-L@0.37 → GPT-4.**)
- **Results:** matches the best individual LLM (GPT-4) with **up to 98% cost
  reduction**, *or* **+4% accuracy at the same cost.** Per dataset, cost savings
  while matching GPT-4: **HEADLINES 98.3%, OVERRULING 73.3%, COQA 59.2%.**
  → Savings are highest on easy-skewed data (HEADLINES) where the small model
  resolves most queries, and drop on harder conversational data (COQA).

### 2.2 AutoMix — self-verification cascade — arXiv 2310.12963

Source: <https://arxiv.org/abs/2310.12963> (NeurIPS 2024) ·
<https://automix-llm.github.io/automix/>

- **Training-free self-verification.** (i) A **small model** answers; (ii) the
  *same* small model does **few-shot self-verification** of its own answer (no
  separately trained verifier, unlike FrugalGPT's DistilBERT); (iii) a
  **POMDP-based meta-verifier** maps the noisy self-verification signal to a
  route, escalating to a larger model when warranted (the POMDP handles
  self-verification's unreliability by treating the score as a noisy observation).
- **Results:** across 5 models / 5 datasets, **>50% cost reduction at comparable
  performance**, with a consistently higher **Incremental Benefit per Cost (IBC)**
  than the linear small↔large interpolation.

**FrugalGPT vs AutoMix:** FrugalGPT trains an *external* scorer on labeled data;
AutoMix uses the generator's *own* few-shot self-verification + a probabilistic
meta-verifier — no extra training. For a harness, AutoMix-style self-verification
is the cheaper-to-adopt pattern (no labeled training set required).

### Routing/cascade headline-number table

| System | Type | Mechanism | Headline number | Source |
|---|---|---|---|---|
| RouteLLM | Router | Win-prediction (MF/SW/BERT/causal-LLM) + cost threshold | ~85% cost cut on MT-Bench @95% GPT-4; >2×/1.9×/1.4× vs random on MT-Bench/MMLU/GSM8K | [2406.18665](https://arxiv.org/abs/2406.18665) |
| Martian | Router (comm.) | Prompt-difficulty classification ("Model Mapping") | 40–70% savings, <2% quality loss | [link](https://newsroom.accenture.com/news/2024/accenture-invests-in-martian-to-bring-dynamic-routing-of-large-language-queries-and-more-effective-ai-systems-to-clients) |
| OpenRouter Auto | Router (comm.) | NotDiamond meta-model + 0–10 cost/quality dial | No surcharge; sticky routing for cache hits | [docs](https://openrouter.ai/docs/guides/routing/routers/auto-router) |
| NotDiamond | Router (comm.) | Learned meta-model, per-query best model | 5–20% acc gain; +39% SRE; #12 RouterArena (cost) | [site](https://www.notdiamond.ai/) |
| Unify | Router (comm.) | Neural quality scorer + live cost/latency; 3 sliders | Quality predicted before routing | [link](https://unify.ai) |
| Portkey | Gateway (rule-based) | Conditional routing + weighted load balancing | Policy-driven, not ML | [docs](https://portkey.ai/docs/product/ai-gateway/conditional-routing) |
| FrugalGPT | Cascade | DistilBERT scorer + per-model thresholds, early-exit | Up to 98% cost cut matching GPT-4; or +4% acc | [2305.05176](https://arxiv.org/abs/2305.05176) |
| AutoMix | Cascade | Few-shot self-verification + POMDP meta-verifier | >50% cost reduction, comparable perf | [2310.12963](https://arxiv.org/abs/2310.12963) |

---

## 3. Speculative Decoding, Draft Models & Speculative Editing

### 3.1 Foundational papers (lossless acceleration)

- **Leviathan et al., "Fast Inference from Transformers via Speculative Decoding"**
  (Google), arXiv [2211.17192](https://arxiv.org/abs/2211.17192). A small **draft**
  model autoregressively proposes γ tokens; the large **target** model scores all
  γ+1 positions **in one parallel forward pass**; a **speculative sampling**
  acceptance rule keeps the longest correct prefix and resamples from an adjusted
  residual on rejection. **2×–3× speedup on T5-XXL (11B)**, provably **identical
  output distribution** (lossless, no retraining).
- **Chen et al. (DeepMind), "Accelerating LLM Decoding with Speculative Sampling"**
  arXiv [2302.01318](https://arxiv.org/abs/2302.01318). Same draft-then-verify;
  **2×–2.5× speedup on Chinchilla (70B)**, distribution-preserving. The insight:
  parallel scoring of a short continuation costs ≈ sampling one token from the big
  model.

### 3.2 Draft-free / self-speculative variants (brief)

- **Medusa** ([2401.10774](https://arxiv.org/abs/2401.10774)) — adds lightweight
  decoding **heads** predicting tokens t+1, t+2, … in parallel, verified with
  **tree attention.** Medusa-1 ≈ **2.2×**, Medusa-2 ≈ **2.3×–3.6×**. No separate
  draft model needed.
- **EAGLE** ([2401.15077](https://arxiv.org/abs/2401.15077)) — drafts at the
  **second-to-top-layer feature level** (more predictable than tokens). **~3× vs
  vanilla; 2.7×–3.5× on LLaMA2-Chat 70B.** EAGLE-2
  ([2406.16858](https://arxiv.org/abs/2406.16858)) adds dynamic draft trees.
- **Self-speculative decoding** — the family where the draft is produced by the
  target model itself (layer-skipping / added heads), avoiding a second model
  while staying lossless.

### 3.3 Speculative EDITING applied to code (the agent-relevant case)

When applying an edit, **most of the file is unchanged**, so you already have a
near-perfect "draft" — the existing source. This eliminates the probabilistic
draft *model* entirely.

- **Cursor "Instant Apply / Speculative Edits"** —
  [cursor.com/blog/instant-apply](https://cursor.com/blog/instant-apply),
  [fireworks.ai/blog/cursor](https://fireworks.ai/blog/cursor).
  - **Two stages:** (1) a frontier model **plans** *what* to change; (2) an
    **apply** model re-emits the file with the change.
  - **Mechanism (quote):** *"With code edits, we have a strong prior on the draft
    tokens … so we can speculate on future tokens using a **deterministic algorithm
    rather than a draft model**."* The **original file's tokens are the draft**; the
    target model verifies long unchanged runs in bulk, diverging only at edited
    regions. Because speculations span the whole unchanged remainder (not γ≈4–8
    tokens), throughput is far higher than classic speculative decoding.
  - **Numbers:** **~1000 tokens/s (~3500 chars/s)** on a fine-tuned **Llama-3-70B**
    fast-apply model — **~13× faster than vanilla Llama-3-70B** and **~9× faster**
    than a prior GPT-4-based deployment; the apply model **surpasses GPT-4o** on
    apply accuracy.
  - **Format detail:** moved from `+`/`-` unified diffs to **full-file rewrite /
    search-replace blocks**, more robust to small-model errors (outperforms diff
    formats for files < ~400 lines).

**Why it matters for any coding agent:** the dominant edit pattern is "rewrite this
file with a small change." Treating prior file contents as deterministic draft
tokens turns O(n) generation into mostly O(1) parallel verification over unchanged
regions — apply latency scales with **edit size**, not **file size.**

---

## 4. Prompt Caching Across Providers

| Provider | Mode | Cached-read discount | Write surcharge | Min tokens | TTL | Storage fee |
|---|---|---|---|---|---|---|
| **Anthropic** | Explicit (`cache_control`) | **90%** (0.1×) | **1.25×** (5m) / **2×** (1h) | 1,024 (model-dep.) | 5 min / 1 hr | none |
| **OpenAI** | Automatic | **50%** | none | 1,024 (+128 steps) | ~5–60 min | none |
| **Gemini** | Implicit + Explicit | **75%** (2.0) / **90%** (2.5+) | input price to create | ~1,024–4,096 impl. / ~2,048 expl. | 1 hr default | ~$1–4.50/M-tok-hr (explicit only) |
| **DeepSeek** | Automatic (disk) | **~90–98%** ($0.014 vs $0.14 /M) | none | prefix block | implicit | none |

- **Anthropic** ([docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))
  — up to **4 `cache_control` breakpoints**; cache is structured strictly as
  **Tools → System → Messages**, and a change at any level invalidates that level
  *and everything after it*. So **tool definitions must come first and stay
  byte-stable.** 5m write breaks even on the 2nd request, 1h write on the 3rd.
- **OpenAI** ([docs](https://developers.openai.com/api/docs/guides/prompt-caching))
  — fully automatic, no fee, **exact-prefix matching** on prompts ≥1,024 tokens
  growing in 128-token steps. Put static content first, variable content last.
- **Gemini** ([docs](https://ai.google.dev/gemini-api/docs/caching)) —
  **implicit** (auto, no guarantee) + **explicit** (`CachedContent` handle,
  guaranteed savings but **per-token-hour storage rent** — only worth it if
  re-queried ~3–4×+ within TTL). 75% (2.0) / 90% (2.5+) discount.
- **DeepSeek**
  ([docs](https://api-docs.deepseek.com/news/news0802)) — automatic disk-based
  prefix caching, no storage fee: **hit ≈ $0.014/M vs miss ≈ $0.14/M** (10× / ~90%
  cheaper on the cached portion).

### 4.1 How agent harnesses exploit caching (the practical playbook)

1. **Stable, append-only prefix.** Keep system prompt + tool defs + early context
   byte-identical and **only append** new turns at the tail. All four providers
   match on *exact prefix*; any mutation near the front invalidates downstream.
2. **Tools first, then system, then messages.** Anthropic enforces this hierarchy;
   a tool-definition change busts the whole chain → **freeze tool schemas, never
   reorder per request.** Same front-loading principle on OpenAI.
3. **Place a breakpoint at the end of the largest stable block** (end of
   tools+system, end of a large injected document). Up to 4 on Anthropic.
4. **Put volatile content last** (timestamps, per-request user input, changing
   retrieved snippets) after the final breakpoint, so it never poisons the prefix.
5. **Match TTL to cadence.** Anthropic 1-hour TTL (2× write) for multi-minute agent
   loops; 5-min default for bursty sessions. Pre-warm with `max_tokens: 0`.
6. **DeepSeek/OpenAI need no code** — the only lever is prompt *structure*: long
   stable prefix, variable suffix.

---

## 5. Mixture-of-Agents, LLM-as-Judge & Self-Consistency (quality levers for cheaper models)

These raise a cheap model's *quality ceiling* by spending more cheap calls (and
selective expensive verification), letting you use a cheaper base model overall.

- **Mixture-of-Agents (MoA)** — Wang et al., Together AI, arXiv
  [2406.04692](https://arxiv.org/abs/2406.04692) (ICLR 2025).
  **Layered architecture:** each layer's agents receive the query + concatenated
  outputs of the prior layer; **proposers** generate diverse candidates, a final
  **aggregator** synthesizes. Default: 3 layers × 6 proposers, Qwen1.5-110B
  aggregator, **all open-source.** **AlpacaEval 2.0: 65.1% vs 57.5% for GPT-4
  Omni** — collective intelligence of cheaper models beating a frontier model, at
  N× inference and added sequential latency. Role finding: a good *proposer* can be
  a poor *aggregator*.
- **LLM-as-a-Judge** — Zheng et al., arXiv
  [2306.05685](https://arxiv.org/abs/2306.05685) (NeurIPS 2023). GPT-4 judges reach
  **>80% agreement with human preferences** (≈ human–human agreement). **Biases:**
  position, verbosity, self-enhancement (mitigate by swapping answer order).
  **Verification-loop framing:** a cheap judge call gates a cheap model's output;
  below threshold → **regenerate or escalate.** You pay the premium only on the
  fraction that fails.
- **Self-Consistency** — Wang et al., arXiv
  [2203.11171](https://arxiv.org/abs/2203.11171) (ICLR 2023). Sample N diverse CoT
  chains (paper uses up to 40), **majority-vote** the answer. **GSM8K +17.9pp
  (PaLM-540B 56.5%→74.4%)**, SVAMP +11.0, AQuA +12.2. Sampling N from a cheap model
  and voting can close much of the gap to an expensive model — net-positive when
  the cheap model is 10–30× cheaper per token.

---

## 6. Reasoning-Effort / Thinking-Budget Knobs (per-task cost dial)

In all three providers, thinking/reasoning tokens **bill as output tokens.** Dial
down for trivial tasks, up for hard reasoning.

- **OpenAI `reasoning_effort`**
  ([guide](https://developers.openai.com/api/docs/guides/reasoning)) —
  `minimal | low | medium (default) | high` (GPT-5.5 adds `none` and `xhigh`).
  Reasoning tokens billed as output, **discarded between turns**. GPT-5 launch
  data: **high vs medium = 65% vs 64%** success but **~2× cost ($511 vs $280)** →
  start at `medium`, escalate only when evals justify it.
- **Anthropic extended thinking `budget_tokens`**
  ([docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking))
  — min **1,024**, must be < `max_tokens`. Full thinking tokens billed as output.
  Diminishing returns above ~32k. **Prompt-cache gotcha:** changing the thinking
  budget mid-conversation **invalidates message cache breakpoints** (system prompt
  stays cached). Use the **1-hour cache** for multi-step thinking workflows since
  sessions exceed the 5-min TTL.
- **Gemini `thinkingBudget`** ([docs](https://ai.google.dev/gemini-api/docs/thinking)):

  | Model | Range | Disable (0)? | Default |
  |---|---|---|---|
  | 2.5 Flash | 0–24,576 | Yes | Dynamic (-1) |
  | 2.5 Pro | 128–32,768 | No | Dynamic (-1) |
  | 2.5 Flash-Lite | 512–24,576 | Yes | Off (opt-in) |

  `0` = off, `-1` = dynamic (model sizes its own budget). Thinking tokens billed as
  output.

---

## 7. Semantic Caching & Embedding Dedup

**Mechanism (common):** embed the request → **vector-similarity (cosine) lookup**
against past requests → on a near-match above threshold, **return the cached
response** instead of calling the LLM. Often two-level: hash for exact hits +
vector search for paraphrase/near-duplicate hits. Central tradeoff:
**false positives** (wrong cached answer) vs **savings** vs **hit latency**.

- **GPTCache** (Zilliz, <https://github.com/zilliztech/GPTCache>) — embedding
  generator → vector store (Milvus/FAISS/PGVector) → similarity evaluator → cache
  storage with LRU/FIFO/LFU. Markets **"10× cost cut, 100× speed"** (illustrative,
  not benchmarked).
- **Portkey Semantic Cache**
  ([blog](https://portkey.ai/blog/semantic-caching-thresholds/)) — threshold
  starts ~**0.95**, tuned to keep accuracy >99%. AWS benchmark: **up to ~86% cost
  reduction, ~88% latency improvement.** Loosening **0.99→0.75** lost **<1pp
  accuracy** while raising savings **15.8%→86.3%.** Keep false-positive rate
  below ~3–5%.
- **Redis Semantic Cache** — RediSearch vector similarity on top of key-value, so
  exact + semantic match live in one store (two-level pattern).
- **Embedding dedup** is the request-side analog: collapse paraphrased requests in
  a queue/batch to one LLM call.

> ⚠️ **Caution for coding agents:** semantic caching is *risky* for code edits and
> file-specific tool calls — two prompts that look similar can require different
> edits to different files. Restrict semantic caching to **idempotent, read-only,
> context-free** sub-tasks (e.g. "explain this error message", doc lookups,
> classification of intent), never to file mutations.

---

## 8. Decision Framework: Task Type → Model Tier (for a coding agent)

Tiers (model-agnostic): **Frontier** (Opus/GPT-5-high/Gemini-Pro class),
**Mid** (Sonnet/GPT-5-medium/Gemini-Flash class), **Cheap/Fast** (Haiku/
GPT-5-mini/Flash-Lite class), **Tiny/Local** (fast-apply or embedding models).

| Task type | Recommended tier | Reasoning budget | Why |
|---|---|---|---|
| **Planning / architecture / multi-file refactor design** | **Frontier** | high / large | Hard reasoning where errors cascade; the one place to pay full price. RouteLLM/Martian say route *hard* prompts here. |
| **Code generation / non-trivial edits** | **Mid** | medium | Best cost/quality balance; escalate to Frontier via cascade only if a verifier/test fails (FrugalGPT pattern, AutoMix self-verify). |
| **Applying a known edit to a file (fast apply)** | **Tiny** (fast-apply) | none | Most tokens are unchanged → speculative editing on the existing file makes this ~13× faster and cheaper than a frontier model (Cursor). |
| **Summarizing files / conversation compaction** | **Cheap/Fast** | minimal/off | Low-stakes transformation; cheap model is near-indistinguishable. Reasoning off. |
| **Classification / intent routing / "which tool"** | **Cheap/Fast** or a dedicated router classifier | none | This *is* the router. Small BERT/embedding classifier or cheap LLM; sub-cent per call. |
| **Autocomplete / inline suggestion** | **Tiny/Fast** | none | Latency-critical; quality bar is low and user filters; speculative decoding + small model. |
| **Commit messages / PR descriptions / renaming** | **Cheap/Fast** | minimal | Stylistic, low-stakes, high-volume. |
| **Debugging hard logic / tricky test failures** | **Frontier** | high | Genuine reasoning; self-consistency (sample N + vote) or MoA can substitute a cheaper base. |
| **Verification / judging a candidate output** | **Mid** as judge | low | LLM-as-judge agrees ~80% with humans; judge is far cheaper than re-generating at Frontier. |
| **Bulk read-only Q&A / doc lookup** | **Cheap/Fast** + semantic cache | off | Idempotent & cacheable; semantic cache can serve ~86% of repeats. |

**Stacking the levers:** route by task type (§8) → run the cheap tier first with a
verifier and cascade-escalate on failure (§2) → keep the system/tool prefix stable
and append-only so every call hits the prompt cache (§4) → use a fast-apply/
speculative-editing model for the apply step (§3) → set the reasoning budget per
task tier (§6) → semantic-cache only the idempotent read-only sub-tasks (§7).

---

## Primary sources

**Routing/cascades:** [RouteLLM 2406.18665](https://arxiv.org/abs/2406.18665) ·
[FrugalGPT 2305.05176](https://arxiv.org/abs/2305.05176) ·
[AutoMix 2310.12963](https://arxiv.org/abs/2310.12963) ·
[RouterArena 2510.00202](https://arxiv.org/html/2510.00202v3) ·
[OpenRouter Auto](https://openrouter.ai/docs/guides/routing/routers/auto-router) ·
[NotDiamond](https://www.notdiamond.ai/) ·
[Portkey routing](https://portkey.ai/docs/product/ai-gateway/conditional-routing)
**Speculative:** [Leviathan 2211.17192](https://arxiv.org/abs/2211.17192) ·
[Chen/DeepMind 2302.01318](https://arxiv.org/abs/2302.01318) ·
[Medusa 2401.10774](https://arxiv.org/abs/2401.10774) ·
[EAGLE 2401.15077](https://arxiv.org/abs/2401.15077) ·
[Cursor instant-apply](https://cursor.com/blog/instant-apply) ·
[Fireworks×Cursor](https://fireworks.ai/blog/cursor)
**Caching:** [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) ·
[OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) ·
[Gemini](https://ai.google.dev/gemini-api/docs/caching) ·
[DeepSeek](https://api-docs.deepseek.com/news/news0802)
**Quality levers / budgets / semantic cache:**
[MoA 2406.04692](https://arxiv.org/abs/2406.04692) ·
[LLM-as-Judge 2306.05685](https://arxiv.org/abs/2306.05685) ·
[Self-Consistency 2203.11171](https://arxiv.org/abs/2203.11171) ·
[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) ·
[Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) ·
[Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking) ·
[GPTCache](https://github.com/zilliztech/GPTCache) ·
[Portkey semantic caching](https://portkey.ai/blog/semantic-caching-thresholds/)
