# How Cursor, Windsurf, and GitHub Copilot Use Multiple Models (and Cheaper Models) for Different Tasks

> **Research report** — June 2026. Scope: model pickers, automatic routing, custom small/fast models for inline tasks, fast-apply / speculative edits, agent-mode model choices, premium/credit pricing, and the underlying economics. Each claim is tagged **[DOCUMENTED]** (vendor primary source) or **[REPORTED]** (third-party reporting/inference). URLs are inline and collected at the end.
>
> **Note on freshness:** Several vendor docs are live pages, so the *specific* model names below (GPT-5.x, Claude Opus 4.x/Fable 5, Gemini 3.x, Composer 2.x, SWE-1.6) reflect mid-2026 and will keep churning. The **structural facts** — custom small completion models, fast-apply via speculative decoding, auto-routing, multiplier/credit pricing — are stable across releases.

---

## 0. The thesis in one paragraph

Every major AI coding tool has converged on the same two-tier model architecture. **High-frequency, latency-critical, low-reasoning tasks** (inline autocomplete, "tab" next-edit prediction, applying/materializing an edit into a file, codebase retrieval) run on **small, custom, in-house models** optimized for cost and sub-second latency — frequently accelerated with **speculative decoding / speculative edits**. **Low-frequency, latency-tolerant, reasoning-heavy tasks** (chat, multi-step agentic coding) run on **expensive frontier models** chosen via a **model picker** or an **automatic router** that reserves the costly models for genuinely hard work. Pricing (request pools, premium-request multipliers, credit multipliers) is deliberately designed to push routine work onto the cheap path.

---

## 1. Cursor

### 1.1 The model picker
- **[DOCUMENTED]** Cursor offers frontier models from multiple providers plus its own in-house models. The lineup spans Anthropic (Claude Sonnet/Opus, Fable 5), OpenAI (GPT-5.x including Codex variants), Google (Gemini 3 Flash/Pro), xAI (Grok), Moonshot (Kimi), and Cursor's own **Composer** family. The active model is shown in the picker at the top of the chat panel. — https://cursor.com/docs/models-and-pricing , https://cursor.com/help/models-and-usage/available-models

### 1.2 "Auto" model selection / routing
- **[DOCUMENTED]** Auto selects a model per request to "balance intelligence, cost, and reliability," and "the specific model used can vary between conversations." Auto draws from a curated pool of premium models. — https://cursor.com/help/models-and-usage/available-models , https://cursor.com/docs/models-and-pricing
- **[REPORTED]** Third-party reverse-engineering claims Auto only picks from a restricted "premium" shortlist, excludes cheaper/older variants, and prioritizes API uptime/predictable latency — but Cursor publishes **no official algorithm or routing percentages**. ("Auto doesn't actually consider all available models… it only picks from what Cursor calls 'premium' models," with "no clear definition of 'premium' models.") — https://dredyson.com/the-hidden-mechanics-of-cursors-auto-model-selection-an-expert-technical-breakdown/

### 1.3 Agent mode + Composer (Cursor's in-house agent model)
- **[DOCUMENTED]** Composer is Cursor's in-house agent model, "a frontier model that is 4x faster than similarly intelligent models," built for low-latency agentic coding (most turns under 30 seconds). Cursor 2.0 reoriented the UI around agents (parallel agents via git worktrees / remote machines). — https://cursor.com/blog/composer , https://cursor.com/blog/2-0
- **[DOCUMENTED]** Cursor ships fresh Composer checkpoints frequently via real-time RL (the same on-policy cadence it uses for Tab; see §2). — https://cursor.com/blog/real-time-rl-for-composer (cadence specifics best confirmed there directly)

### 1.4 "Max" mode
- **[DOCUMENTED]** Max Mode "extends the context window to the maximum a model supports," is "available on all models," and is most impactful above the default ~200k-token window (some models reach ~1M). It uses **token-based pricing** and "a single request can use significantly more of your usage budget than a normal request." It's billed at the model's API rate on current plans; legacy request-based plans add a **~20% surcharge**. — https://cursor.com/docs/context/max-mode , https://cursor.com/help/models-and-usage/usage-limits
- **[REPORTED]** Max Mode also reportedly raises the tool-call limit (e.g. 25 → 200 per interaction); came from a search summary, not verbatim-confirmed in the doc body.

### 1.5 How Cursor routes/cascades cheap vs expensive (documented vs inferred)
- **[DOCUMENTED]** Cursor splits usage into two pools so the cheap path is structurally favored: an **Auto + Composer pool** with "significantly more included usage," and an **API pool** "charged at the model's API price." — https://cursor.com/blog/increased-agent-usage , https://cursor.com/docs/models-and-pricing
- **[REPORTED]** Because Composer is far cheaper to serve and lives in its own pool, analysts infer Auto increasingly routes routine requests to Composer rather than premium third-party models — but "without visibility into your model distribution, you're guessing." No explicit cheap→expensive **cascade/fallback chain** is documented; the closest documented behavior is Auto switching models on quality/availability dips. — https://www.vantage.sh/blog/cursor-composer-2

### 1.6 Pricing & incentives
- **[DOCUMENTED]** Plans bundle a dollar amount of API agent usage plus "generous" included Auto/Composer usage (e.g. Pro $20/mo ≈ $20 API usage + included Auto/Composer; Ultra $200/mo ≈ $400 API usage). When included usage runs out, users enable pay-as-you-go at API rates. — https://cursor.com/help/models-and-usage/usage-limits
- **[REPORTED]** Cursor moved from fixed request allocations to **token-consumption billing**; cost per request varies by model and task complexity, inherently incentivizing cheaper models for simple tasks. — https://www.vantage.sh/blog/cursor-pricing-explained

---

## 2. Cursor Tab — the cheap proprietary next-edit-prediction model

This is the canonical example of "a custom small model beats frontier models for high-frequency inline tasks."

- **[DOCUMENTED]** Tab is a **purpose-built proprietary model**, not a frontier model: "Built exclusively for Cursor, trained with RL on the largest sample of real-world scenarios." It is a "**custom sparse language model trained to predict edits on billions of tokens.**" — https://cursor.com/product/tab , https://cursor.com/blog/tab-update
- **[DOCUMENTED]** Tab does **next-action prediction**, not just autocomplete: it predicts edits near the cursor *and where to jump next* ("Tab predicts your next editing location and jumps there," including cross-file edits). — https://cursor.com/help/ai-features/tab , https://cursor.com/product/tab
- **[DOCUMENTED]** The "Fusion" Tab model "accurately predicts over 25% more difficult edits per line" and suggests "over 10x longer stretches of changes." It cut **server latency p50 from 475ms to 260ms** and expanded context from **5,500 to 13,000 tokens**. — https://cursor.com/blog/tab-update
- **[DOCUMENTED — the volume argument for "why cheap"]** "Tab now produces over a billion edited characters per day," request rate "grown ~100x since our original model launch," and Tab "runs on every user action, handling **over 400 million requests per day**." Frontier-model cost/latency is infeasible at that scale. — https://cursor.com/blog/tab-update , https://cursor.com/blog/tab-rl *(400M/day figure re-confirmed by direct fetch)*
- **[DOCUMENTED]** Online RL makes Tab smarter about *when* to fire: the RL model "makes **21% fewer suggestions** than the previous model while having a **28% higher accept rate**." Trained with policy-gradient RL (reward +0.75 accepted, −0.25 rejected, 0 if nothing shown) — i.e. learning to stay silent, not post-hoc filtering. — https://cursor.com/blog/tab-rl *(re-confirmed by direct fetch)*
- **[DOCUMENTED]** On-policy RL requires frequent rollouts: "rolling out new models to users frequently throughout the day," currently "**1.5 to 2 hours to roll out a checkpoint** and collect the data." — https://cursor.com/blog/tab-rl *(re-confirmed by direct fetch)*

**Why custom small models win here:** the task is mechanical (predict the next edit), the latency budget is sub-second on every keystroke, and the request volume is enormous — exactly the regime where a small specialized model dominates a frontier model on cost *and* latency *and* (after RL on real accept/reject data) acceptance quality.

### 2.1 Cursor's "Apply" / Instant Apply model (fast-apply)
- **[DOCUMENTED]** Cursor splits edits into **planning** (frontier model in chat) and **applying** (custom fast model): "the planning phase takes the form of a chat interface with a powerful frontier model"; "Applying the change to the current file should be straightforward and instant." — https://cursor.com/blog/instant-apply
- **[DOCUMENTED]** Throughput: "~**1000 tokens (around 3500 char/s) on our 70b model** using a speculative-decoding variant tailored for code-edits" — a "**~13x speedup** over vanilla Llama-3-70b" and "**~9x speedup** over our previous GPT-4 speculative edits deployment." The fine-tuned model (llama-3-70b-ft) "almost matches claude-3-opus … and outperforms gpt-4-turbo and gpt-4o" on apply quality. — https://cursor.com/blog/instant-apply
- **[DOCUMENTED]** A custom model was **necessary**: "It is not possible to build speculative edits into any of anthropic's models, so we need to train and deploy a performant custom model." — https://cursor.com/blog/instant-apply
- **[REPORTED]** Cursor's framing (relayed by Fireworks): frontier models "struggle with large code edits — laziness, inaccuracy, high latency," motivating the dedicated apply model; the model rewrites the *full file* conditioned on current file + conversation + diff. — https://fireworks.ai/blog/cursor , https://blog.getbind.co/2024/10/02/how-cursor-ai-implemented-instant-apply-file-editing-at-1000-tokens-per-second/

---

## 3. Windsurf (formerly Codeium)

> **Context:** Windsurf/Codeium was acquired by **Cognition** (makers of Devin) in 2025. `windsurf.com`/`docs.windsurf.com` now redirect to `cognition.ai`/`docs.devin.ai`; those redirected pages are the canonical primary sources and are tagged **[DOCUMENTED]** below.

### 3.1 Cascade (the agent) and its models
- **[DOCUMENTED]** Cascade is Windsurf's agentic coding agent. Cascade offers premium frontier models (Anthropic Claude, OpenAI GPT, Google Gemini) **plus Windsurf's own SWE models** (SWE-1.6, SWE-1.5, Adaptive, Arena tiers). — https://docs.devin.ai/desktop/models
- **[DOCUMENTED]** SWE-1.5 "powers Windsurf's coding agent," built by "co-optimizing models and harness" — the Cascade harness + RL on custom coding environments. — https://cognition.ai/blog/swe-1-5
- **[DOCUMENTED — founder interview]** For high-level planning, Windsurf relies on **external** frontier models: "The planning models right now, undoubtedly … the C[l]o[u]ds [Claudes] and the OpenAIs have the best products." — https://www.latent.space/p/windsurf

### 3.2 The cheap base / autocomplete model
- **[DOCUMENTED]** Autocomplete runs on Codeium's **own in-house models**, "trained in-house from scratch to optimize for speed and accuracy." Founder: "autocomplete and supercomplete that run on every keystroke are entirely … our own models." A **Fast Autocomplete** tier is gated to paid users. — https://docs.devin.ai/desktop/autocomplete/overview , https://www.latent.space/p/windsurf
- **[REPORTED — primary quotes]** SWE-1-mini powers the predictive "Windsurf Tab"; SWE-1-lite replaced the original free "Cascade Base" cheap model. — https://www.maginative.com/article/windsurf-launches-swe-1-homegrown-ai-models-for-software-engineering/

### 3.3 Model selection & credit costs (the incentive structure)
- **[DOCUMENTED]** Windsurf-native models are **free or cheap**: SWE-1.6 / SWE-1.5 standard = **0 credits**; SWE-1.6 Fast = 0.5x; Adaptive = 1.5x. External frontier models carry **much higher multipliers**: Claude Sonnet 4.6 Thinking ≈ 6x, GPT-5.5 Low-Thinking ≈ 8x, Claude Fable 5 Medium ≈ 50x. — https://docs.devin.ai/desktop/models
- **[DOCUMENTED]** "When you send a message to Cascade with a **premium** model, **1 prompt credit** is consumed" — and you "only pay for the initial prompt" regardless of how many actions Cascade takes; failed operations are not charged. Each model has its own credit multiplier (baseline = 1). — https://docs.devin.ai/desktop/accounts/usage

### 3.4 Routing / fast context / why they built SWE models
- **[DOCUMENTED]** **Fast Context** uses small custom retrieval models — **SWE-grep / SWE-grep-mini** — auto-triggered, up to 20x faster than a frontier model: SWE-grep-mini ">2,800 tokens/second," SWE-grep ">650 tokens/second," mini "20x faster" than Haiku 4.5 (~140 tok/s). A fast retrieval *subagent* "conserves context budget (and intelligence) for the main agent" and avoids "context pollution," running "up to 8 parallel tool calls per turn in a maximum of 4 turns." — https://cognition.ai/blog/swe-grep
- **[DOCUMENTED]** Codeium built proprietary **distributed retrieval** (rather than embeddings) for big codebases: "for complex questions, we don't believe embeddings can encapsulate all the granularity … Run custom models at scale across large code bases." (the "Riptide"/"M-Query" lineage). — https://www.latent.space/p/windsurf
- **[REPORTED]** Riptide/M-Query internals (relevance-scoring LLM, multi-GPU parallel inference, "~200% recall improvement over embeddings") are third-party-described, not confirmed on a primary page. — https://research.contrary.com/company/windsurf , https://markaicode.com/windsurf-flow-context-engine/
- **[DOCUMENTED + REPORTED]** Why they built SWE models: a general "coding-capable" model won't cover full-lifecycle SWE work, so they optimize the model *with* the Cascade harness. SWE-1.5 is "frontier-size … hundreds of billions of parameters," served via **Cerebras at up to 950 tok/s — 6x faster than Haiku 4.5 and 13x faster than Sonnet 4.5** (e.g. Kubernetes manifest edits in <5s vs ~20s). — https://cognition.ai/blog/swe-1-5 ; SWE-1 launch framing via https://www.maginative.com/article/windsurf-launches-swe-1-homegrown-ai-models-for-software-engineering/

**Net:** Windsurf runs the exact same split — small in-house models for per-keystroke autocomplete and for retrieval, frontier (or large in-house SWE) models for planning — with **0-credit native models vs 6x–50x frontier multipliers** strongly nudging users to the cheap path.

---

## 4. GitHub Copilot

### 4.1 The model picker (multiple frontier models)
- **[DOCUMENTED]** Copilot supports models from OpenAI, Anthropic, Google, and Microsoft; "availability varies by model and platform" (GitHub.com, CLI, VS Code, Visual Studio, JetBrains, Eclipse, Xcode). Current lineup includes OpenAI GPT-5.x (incl. Codex variants), Anthropic Claude Haiku/Sonnet/Opus/Fable, Google Gemini 2.5/3.x, Microsoft MAI-Code-1-Flash, and GitHub-fine-tuned "Raptor mini." — https://docs.github.com/en/copilot/reference/ai-models/supported-models
- **[DOCUMENTED]** The multi-model picker launched in 2024: "Now you can also control which foundational LLM you use" (first added Claude 3.5 Sonnet, Gemini 1.5 Pro, OpenAI o1-preview/o1-mini). Rationale: "Different models excel at different tasks … different trade-offs between speed, reasoning depth, and multimodal capabilities." — https://github.blog/news-insights/product-news/bringing-developer-choice-to-copilot/ , https://github.blog/ai-and-ml/github-copilot/under-the-hood-exploring-the-ai-models-powering-github-copilot/

### 4.2 The cheap inline COMPLETION model (Codex → GPT-4o → GPT-4.1 Copilot), distinct from Chat
- **[DOCUMENTED]** Copilot launched in 2021 "powered by **Codex, a GPT-3 descendant**." — https://github.blog/ai-and-ml/github-copilot/under-the-hood-exploring-the-ai-models-powering-github-copilot/
- **[DOCUMENTED]** The completion engine is a **purpose-built fill-in-the-middle (FIM) model**, fundamentally different from chat models (chat models "experience cursor-misaligned inserts, duplication … overwrites"). GitHub "trained models specialized in completions … to behave like a great FIM engine." The custom completion model delivers "**3x higher token-per-second throughput, and a 35% reduction in latency**" — explicitly aiming for "**faster, cheaper, higher-quality completions**." — https://github.blog/ai-and-ml/github-copilot/the-road-to-better-completions-building-a-faster-smarter-github-copilot-with-a-new-custom-model/
- **[DOCUMENTED]** The cheap completion model is refreshed over time: `copilot-codex` (GPT-3.5-based) → **GPT-4o Copilot** ("higher quality … improved latency") → **GPT-4.1 Copilot** ("refined with reinforcement learning," available "to users on all plans," selectable in the code-completion model picker). — https://github.blog/changelog/2025-03-27-gpt-4o-copilot-your-new-code-completion-model-is-now-generally-available/ , https://github.blog/changelog/2025-08-27-copilot-code-completion-now-uses-the-gpt-4-1-copilot-model/
- **[REPORTED]** GPT-4o Copilot was built on GPT-4o mini, fine-tuned on "275k high-quality public repositories" (original VS Code post 404'd; relayed via Visual Studio Magazine). — https://visualstudiomagazine.com/articles/2025/02/19/vs-code-copilot-adds-new-gpt-4o-code-completion-model.aspx
- **[DOCUMENTED — the key economic fact]** Completions are **not** premium-billed: "Code completions remain unlimited for paid plans and aren't billed in AI credits," and paid plans get "unlimited inline suggestions" (subject to rate limiting). The cheap high-frequency path is effectively free. — https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing , https://docs.github.com/en/copilot/concepts/billing/copilot-requests *(re-confirmed by direct fetch)*

### 4.3 "Premium requests" and the per-model multiplier table
- **[DOCUMENTED]** A "request" is any interaction where you ask Copilot to do something; "your premium request allowance is deducted according to [a per-model] multiplier." Allowances: Pro = 300/month, Pro+ = 1500/month. **Crucially:** "If you use all of your premium requests, you can still use Copilot with one of the included models for the rest of the month." — https://docs.github.com/en/copilot/concepts/billing/copilot-requests *(re-confirmed by direct fetch)*
- **[DOCUMENTED]** The (legacy request-based) multiplier table — the cheaper-model incentive in numbers:

  | Model | Multiplier |
  |---|---|
  | GPT-4o / GPT-4o mini / GPT-5 mini / GPT-5.1-Codex-Mini | 0.33x |
  | Claude Haiku 4.5 / Gemini 3 Flash / MAI-Code-1-Flash / Raptor mini | 0.33x |
  | Gemini 2.5 Pro | 1x |
  | GPT-5.1 / 5.1-Codex / 5.1-Codex-Max | 3x |
  | GPT-5.3-Codex / GPT-5.4 / GPT-5.4 mini | 6x |
  | Claude Sonnet 4.5 / Gemini 3 Pro / 3.1 Pro | 6x |
  | Claude Sonnet 4.6 | 9x |
  | Gemini 3.5 Flash | 14x |
  | Claude Opus 4.5 | 15x |
  | Claude Opus 4.6 / 4.7 / 4.8 | 27x |
  | GPT-5.5 | 57x |
  | Copilot code review (action) | 13x |

  Cheapest models stretch the quota **~170x further** than the most expensive (0.33x vs 57x). — https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/model-multipliers-for-annual-plans
- **[DOCUMENTED]** Extra incentive to let Copilot pick: "If you use auto model selection … you qualify for a **10% discount**" (a 1x model becomes 0.9x). — https://docs.github.com/en/copilot/concepts/models/auto-model-selection
- **[DOCUMENTED]** GitHub is migrating to **token-based usage billing** ("1 AI credit = $0.01"; usage by input/output/cached tokens) as of June 2026; multipliers are "specific to the legacy premium request-based billing system." The cheaper-model incentive persists (fewer credits per token). — https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/ , https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing

### 4.4 Agent mode & documented routing
- **[DOCUMENTED]** The asynchronous **coding agent** defaults to a strong Anthropic model (Pro/Pro+ "automatically use Claude Sonnet 4.5"; Business/Enterprise default Claude Sonnet 4 unless admins enable the newer policy). Separate Claude and Codex agents on github.com each have their own model picker. — https://github.blog/changelog/2025-09-30-anthropic-claude-sonnet-4-5-is-in-public-preview-for-copilot-coding-agent/ , https://github.blog/changelog/2026-04-14-model-selection-for-claude-and-codex-agents-on-github-com/
- **[DOCUMENTED]** **Auto model selection actively routes by task**, explicitly reserving expensive models for hard problems: it works by "**reserving higher-cost reasoning models for problems that truly need it, while routing straightforward tasks to faster, lower-cost models**," switching "only at natural cache boundaries" to avoid cache costs. It weighs "real-time model availability and reliability signals" plus a task evaluation across "reasoning, code generation complexity, bug diagnosis difficulty, and tool orchestration needs," yielding "gains in token efficiencies with no quality regression." — https://docs.github.com/en/copilot/concepts/models/auto-model-selection , https://github.blog/changelog/2026-05-20-auto-model-selection-now-routes-based-on-your-task-in-vs-code/

---

## 5. Speculative decoding / speculative edits

This is the technique that makes the "apply" step cheap and fast across all three tools.

### 5.1 Speculative decoding (general)
- **[DOCUMENTED]** A small **draft model** proposes γ tokens; the big **target model verifies them in parallel**; output is provably **identical** to the target model's. The foundational paper reports "**2X–3X acceleration … with identical outputs**" / "without changing the distribution." — https://arxiv.org/abs/2211.17192
- **[REPORTED]** Why it's "free": LLM inference is memory-bound, so verifying several drafted tokens in one forward pass uses otherwise-idle compute. "Especially useful for predictable tasks like code generation"; each draft token accepted with probability min(1, p̃/q̃). — https://bentoml.com/llm/inference-optimization/speculative-decoding

### 5.2 Speculative edits (the code specialization)
- **[DOCUMENTED]** Cursor's key insight: **for an edit, the original file *is* the draft** — no separate draft model needed. "We have a strong prior on the draft tokens … so we can **speculate on future tokens using a deterministic algorithm rather than a draft model**." Result: "equivalent to a full-file-rewrite, while being up to **9x faster**," at "~1000 tokens (3500 char/s) on our 70b model." — https://cursor.com/blog/instant-apply
- **[DOCUMENTED]** Validation stays exact: "The speculation is always validated using **deterministic (greedy) generation**" — the server keeps the longest prefix matching temperature-0 output, so the result is unchanged. — https://fireworks.ai/blog/cursor
- **[DOCUMENTED]** OpenAI **Predicted Outputs** is the same idea as a public API: pass the expected output and "speed up API responses … when many of the output tokens are known ahead of time" — "most common when … regenerating a text or code file with minor modifications." Caveat: "**Any rejected tokens are still billed**," so a bad prediction can raise cost. — https://developers.openai.com/api/docs/guides/predicted-outputs
- **[DOCUMENTED]** Fireworks Predicted Outputs: pass the original code as the `prediction`; "If the prediction is substantially different from the generated output, output generation speed may decrease"; recommends `temperature=0`. The same approach made **Vercel's auto-fixer ~40x faster** than gpt-4o-mini (8,130 vs 238.9 chars/sec). — https://docs.fireworks.ai/guides/predicted-outputs , https://fireworks.ai/blog/vercel
- **[REPORTED]** The intuition: "when you refactor a function, rename a variable, or fix a bug, … **80–99% of the output tokens are predictable**." — https://www.morphllm.com/openai/predicted-outputs

---

## 6. The general economic pattern

| Dimension | Inline completion / Tab / Apply / Retrieval | Agentic / Chat tasks |
|---|---|---|
| Frequency | Every keystroke (Cursor: ~20k calls/sec; ~400M Tab requests/day) | Per user request (low) |
| Latency budget | Sub-second; Copilot targets sub-200ms | Seconds-to-minutes tolerable |
| Reasoning needed | Low (mechanical prediction/rewrite/retrieval) | High (planning, multi-step) |
| Model | Small custom in-house (Tab/Fusion, SWE-mini, GitHub FIM model); fast-apply via speculative edits | Frontier (Claude/GPT/Gemini) or large in-house (Composer, SWE-1.5) |
| Billing | Effectively free / unmetered / 0-credit | Premium requests / credits / API rates |

- **[DOCUMENTED]** Cost asymmetry that justifies small models: "serving a 7bn SLM is **10–30× cheaper** in latency, energy, and FLOPs than a 70–175bn LLM," enabling real-time responses at scale. — https://arxiv.org/pdf/2506.02153
- **[REPORTED]** Architecture framing: "Tab needs low latency for the next keystroke; the Agent needs reasoning depth for a whole task. Splitting them lets each be optimized for its job." Tab is tuned to return "under a second — a very different optimisation target from frontier models used for agent tasks." — https://medium.com/@ayush.s0410/inside-cursor-3-the-architecture-of-an-agent-first-ide-in-2026-60c681a8df1d
- **[REPORTED]** Scale of the cheap path: Cursor autocomplete is "approximately **20,000 model calls per second**," served from "~1,000–2,000 H100 GPUs distributed globally" so it "feels instantaneous." — https://www.zenml.io/llmops-database/scaling-ai-assisted-coding-infrastructure-from-auto-complete-to-global-deployment
- **[REPORTED]** Copilot completion latency target: "**sub-200ms autocomplete**" via HTTP/2, custom load balancing, request handling. — https://www.classcentral.com/course/youtube-github-copilot-s-latency-secrets-how-they-built-sub-200ms-autocomplete-443997

**The bridge:** speculative decoding/edits is what lets the *expensive* operation (rewriting a whole file from a frontier model's described edit) collapse into the *cheap* regime — copying unchanged tokens forward so the marginal cost is only the changed spans. That's why all three tools land on: small custom models for high-frequency inline work, frontier models for low-frequency reasoning, speculative edits gluing the two together, and pricing designed to keep routine work on the cheap path.

---

## Appendix: source list

**Cursor (primary):** https://cursor.com/docs/models-and-pricing · https://cursor.com/help/models-and-usage/available-models · https://cursor.com/docs/context/max-mode · https://cursor.com/help/models-and-usage/usage-limits · https://cursor.com/blog/2-0 · https://cursor.com/blog/composer · https://cursor.com/blog/real-time-rl-for-composer · https://cursor.com/blog/increased-agent-usage · https://cursor.com/product/tab · https://cursor.com/blog/tab-update · https://cursor.com/blog/tab-rl · https://cursor.com/help/ai-features/tab · https://cursor.com/blog/instant-apply
**Cursor (reported):** https://www.vantage.sh/blog/cursor-pricing-explained · https://www.vantage.sh/blog/cursor-composer-2 · https://dredyson.com/the-hidden-mechanics-of-cursors-auto-model-selection-an-expert-technical-breakdown/ · https://blog.getbind.co/2024/10/02/how-cursor-ai-implemented-instant-apply-file-editing-at-1000-tokens-per-second/

**Windsurf/Cognition (primary):** https://docs.devin.ai/desktop/models · https://docs.devin.ai/desktop/autocomplete/overview · https://docs.devin.ai/desktop/accounts/usage · https://cognition.ai/blog/swe-1-5 · https://cognition.ai/blog/swe-grep · https://www.latent.space/p/windsurf
**Windsurf (reported):** https://www.maginative.com/article/windsurf-launches-swe-1-homegrown-ai-models-for-software-engineering/ · https://simonwillison.net/2025/Oct/29/swe-15/ · https://research.contrary.com/company/windsurf · https://markaicode.com/windsurf-flow-context-engine/

**GitHub Copilot (primary):** https://docs.github.com/en/copilot/reference/ai-models/supported-models · https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing · https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/model-multipliers-for-annual-plans · https://docs.github.com/en/copilot/concepts/billing/copilot-requests · https://docs.github.com/en/copilot/concepts/models/auto-model-selection · https://github.blog/ai-and-ml/github-copilot/under-the-hood-exploring-the-ai-models-powering-github-copilot/ · https://github.blog/ai-and-ml/github-copilot/the-road-to-better-completions-building-a-faster-smarter-github-copilot-with-a-new-custom-model/ · https://github.blog/news-insights/product-news/bringing-developer-choice-to-copilot/ · https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/ · https://github.blog/changelog/2025-03-27-gpt-4o-copilot-your-new-code-completion-model-is-now-generally-available/ · https://github.blog/changelog/2025-08-27-copilot-code-completion-now-uses-the-gpt-4-1-copilot-model/ · https://github.blog/changelog/2025-09-30-anthropic-claude-sonnet-4-5-is-in-public-preview-for-copilot-coding-agent/ · https://github.blog/changelog/2026-05-20-auto-model-selection-now-routes-based-on-your-task-in-vs-code/ · https://github.blog/changelog/2026-04-14-model-selection-for-claude-and-codex-agents-on-github-com/
**GitHub Copilot (reported):** https://visualstudiomagazine.com/articles/2025/02/19/vs-code-copilot-adds-new-gpt-4o-code-completion-model.aspx

**Speculative decoding / economics (primary):** https://arxiv.org/abs/2211.17192 · https://developers.openai.com/api/docs/guides/predicted-outputs · https://docs.fireworks.ai/guides/predicted-outputs · https://fireworks.ai/blog/cursor · https://fireworks.ai/blog/vercel · https://arxiv.org/pdf/2506.02153
**Speculative decoding / economics (reported):** https://bentoml.com/llm/inference-optimization/speculative-decoding · https://www.zenml.io/llmops-database/scaling-ai-assisted-coding-infrastructure-from-auto-complete-to-global-deployment · https://medium.com/@ayush.s0410/inside-cursor-3-the-architecture-of-an-agent-first-ide-in-2026-60c681a8df1d · https://www.classcentral.com/course/youtube-github-copilot-s-latency-secrets-how-they-built-sub-200ms-autocomplete-443997 · https://www.morphllm.com/openai/predicted-outputs

### Caveats
- Some Cursor figures (Max Mode tool-call bump 25→200; Composer "every ~5 hours behind Auto") came from search summaries, not verbatim page bodies — treated as **[REPORTED]**. The Tab RL figures (21%/28%, 400M/day, 1.5–2h rollout) and the Copilot included-model/unlimited-completions facts were **re-fetched and confirmed**.
- Windsurf's SWE-Bench Pro head-to-head number and Riptide/M-Query internals are **[REPORTED]**, not confirmed on a primary page.
- All vendor docs are live; specific model names will drift. Structural facts are stable.
