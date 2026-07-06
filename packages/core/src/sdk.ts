import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core';
import { getEnvApiKey, getModel, streamSimple } from '@earendil-works/pi-ai';
import type {
  Context,
  KnownProvider,
  Message,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';

import { AgentSession } from './agent-session.js';
import { BackgroundShellManager } from './background-shells.js';
import type { CommandExecutor } from './command-executor.js';
import { getProviderConfig } from './auth.js';
import { createCompaction } from './compaction.js';
import type { CompactionOptions } from './compaction.js';
import { buildMemorySection } from './memory.js';
import { loadSettings } from './settings.js';
import {
  computeServerConfigHash,
  isServerCacheValid,
  loadMcpCache,
  saveMcpCache,
  type MetadataCache,
} from './mcp-cache.js';
import {
  loadMergedConfig,
  type McpConfigFile,
} from './mcp-config.js';
import { wrapMcpToolAsAgentTool } from './mcp-direct-tool.js';
import { createMcpProxyTool } from './mcp-proxy-tool.js';
import { McpServerManager } from './mcp-server-manager.js';
import { buildCustomModel } from './custom.js';
import {
  streamWithFallback,
  type FallbackAttempt,
} from './model-fallback.js';
import { buildNvidiaModel } from './nvidia.js';
import { buildOllamaModel, DEFAULT_OLLAMA_BASE_URL } from './ollama.js';
import { buildOpenRouterModel, openRouterAppHeaders } from './openrouter.js';
import { seedBuiltinSkills } from './seed.js';
import { loadSession } from './session-store.js';
import { loadSkills, type Skill } from './skills.js';
import { buildSystemPrompt } from './system-prompt.js';
import { loadProjectContext, type SettingSource } from './project-context.js';
import { createPermissionHook, filterTools, type PermissionMode } from './tool-policy.js';
import { createCodingTools, createSkillTool, type Tool } from './tools/index.js';

export { createCodingTools, createAllTools, createBashTool, createReadTool, createEditTool, createWriteTool, createSkillTool } from './tools/index.js';

export interface CreateAgentSessionOptions {
  /** LLM provider name */
  provider?: string;
  /** Model ID within the provider */
  modelId?: string;
  /** OpenAI-compatible endpoint URL. Used by the `custom` provider; also overrides the stored Ollama base URL. */
  baseUrl?: string;
  /** API key for this session only — never persisted. Threaded into the stream call so it works for providers pi-ai's env registry doesn't know. */
  apiKey?: string;
  /** Working directory for tools */
  cwd?: string;
  /** Override the system prompt */
  systemPrompt?: string;
  /** Thinking/reasoning level */
  thinkingLevel?: ThinkingLevel;
  /**
   * Replace the default coding tools with an explicit list. Note this is the
   * *base* set, not the final one: MCP proxy/direct tools (unless
   * `mcpDisabled`/`closedToolSet`) and the `skill` tool (unless
   * `disableSkillTool`/`closedToolSet`) are still layered on top. To swap one
   * tool while keeping the rest (including the background-shell trio) prefer
   * `toolOverrides` or `buildTools`; for an exact, auditable set use
   * `closedToolSet: true`.
   */
  tools?: Tool[];
  /**
   * Transform the default coding tools (executor-backed `bash` + background
   * trio + read/edit/write/todo/memory) into the base set. Receives the
   * defaults and returns the list to use — the "change one thing, keep the
   * rest" composition lever. Applied instead of `tools` when both are given.
   */
  buildTools?: (defaultTools: Tool[]) => Tool[];
  /**
   * Swap individual tools by name on top of the resolved base set. Each key is
   * a tool name; the value replaces a same-named tool, or is appended if none
   * exists. Lets a caller inject e.g. a sandbox-backed `bash` without losing
   * the background-shell trio.
   */
  toolOverrides?: Record<string, Tool>;
  /**
   * Override how shell commands are executed (foreground `bash` and background
   * shells both route through it). Default: the host `child_process` executor,
   * which reproduces prior behavior exactly. A sandbox caller passes e.g. a
   * Docker executor; `read`/`edit`/`write` keep running on the host.
   */
  executor?: CommandExecutor;
  /**
   * Working directory for command *execution* when it differs from `cwd` (the
   * file-tool directory) — e.g. a container bind-mount target like `/work`. The
   * file tools use `cwd`; the executor uses `execCwd`. Defaults to `cwd`.
   */
  execCwd?: string;
  /**
   * Yield exactly the resolved tool set: no MCP proxy/direct tools and no
   * `skill` tool are layered on. Useful for sandboxed/headless callers that need
   * a known, auditable tool list (MCP servers would otherwise spawn on the host,
   * outside any sandbox). Implies `mcpDisabled` and `disableSkillTool`.
   */
  closedToolSet?: boolean;
  /** Skip injecting the `skill` tool even when model-invocable skills exist. */
  disableSkillTool?: boolean;
  /** Compaction options (set to false to disable) */
  compaction?: CompactionOptions | false;
  /** Pre-loaded skills (SDK escape hatch; skips project-dir discovery when provided) */
  skills?: Skill[];
  /**
   * Suppress console output of seed/skill diagnostics. Headless callers
   * (cron ticks, tests) use this to keep their log streams clean; diagnostics
   * are still returned via the result so callers can surface them their own way.
   */
  quiet?: boolean;
  /** Skip MCP entirely (no proxy tool, no direct tools, no manager). */
  mcpDisabled?: boolean;
  /** Inject a merged MCP config instead of reading user/project files. */
  mcpConfigOverride?: McpConfigFile;
  /** Inject an MCP metadata cache instead of reading ~/.harnext/agent/mcp-cache.json. */
  mcpCacheOverride?: MetadataCache;
  /** Auto-approve list (Claude SDK `allowed_tools`). Gates `dontAsk`/`plan`. */
  allowedTools?: readonly string[];
  /** Block list (Claude SDK `disallowed_tools`). Removes tools from view and call. */
  disallowedTools?: readonly string[];
  /** Permission mode (Claude SDK `permission_mode`). */
  permissionMode?: PermissionMode;
  /** Stop after this many assistant turns (Claude SDK `max_turns`). */
  maxTurns?: number;
  /** CLAUDE.md sources to load into the system prompt (Claude SDK `setting_sources`). */
  settingSources?: readonly SettingSource[];
  /** Text appended to the system prompt (Claude SDK `append_system_prompt`). */
  appendSystemPrompt?: string;
  /** Stable session id surfaced in stream-json envelopes. */
  sessionId?: string;
  /**
   * Resume a previously-stored session: load its transcript, seed the agent's
   * history, and continue under the same id. Looks the id up in the local
   * per-cwd session store (`~/.harnext/agent/sessions/<cwd-hash>/<id>.jsonl`).
   * If no stored session is found, falls back to a fresh session.
   */
  resumeSessionId?: string;
  /**
   * Seed the conversation history directly, giving the caller full control
   * instead of loading from the local store. The array is the prior turns —
   * `user`, `assistant`, and `toolResult` messages, in order (these are the
   * roles the model sees; other roles are ignored on the next call). The
   * *system message* is not part of this array: set it via `systemPrompt`
   * (full override) or `appendSystemPrompt`.
   *
   * Takes precedence over `resumeSessionId` when both are given. Pair it with
   * `sessionId` to control the id the continued session is persisted under.
   */
  initialMessages?: AgentMessage[];
  /**
   * Request-time availability fallback (issue #51 / Claude SDK `fallback_model`).
   * When the primary model's request fails *before the first chunk* with a
   * retryable error (429 / 5xx / network), the same turn is transparently
   * retried against this model. `provider` defaults to the primary provider, so
   * a single id like `claude-opus-4-7` "just works". Non-retryable errors
   * (auth/4xx) propagate unchanged.
   */
  fallback?: { provider?: string; modelId: string };
}

export interface CreateAgentSessionResult {
  session: AgentSession;
  /**
   * Seed + skill-loading diagnostics emitted while building the session. When
   * `quiet: true` this is the only way to observe them.
   */
  diagnostics: Array<{ source: 'seed' | 'skill'; type: string; message: string; path: string }>;
  /**
   * The resolved session id (the resumed id when resuming, otherwise the id the
   * session was created with). Persist this to resume the conversation later.
   */
  sessionId: string;
  /** True when prior history was seeded (via `initialMessages` or a matched `resumeSessionId`). */
  resumed: boolean;
}

function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  ) as Message[];
}

/**
 * Resolve a `(provider, modelId)` pair to a pi-ai `Model`. ollama, NVIDIA NIM,
 * and user-supplied custom OpenAI-compatible endpoints use custom builders
 * (their catalogs aren't in pi-ai's static registry); openrouter prefers the
 * registry but hand-builds ids newer than the snapshot; every other provider
 * must be in the registry. No network calls — an id is enough to route the
 * request. Shared by the primary and fallback paths.
 *
 * `baseUrl` (optional) overrides the endpoint for the `custom` and `ollama`
 * providers; ignored by the rest.
 *
 * Exported so callers that swap models mid-session (e.g. the plan→execute model
 * switch) can resolve a Model without rebuilding the whole session.
 */
export function resolveModel(provider: string, modelId: string, baseUrl?: string): Model<string> {
  if (provider === 'ollama') {
    const url = baseUrl ?? getProviderConfig('ollama')?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
    return buildOllamaModel(modelId, url) as Model<string>;
  }
  if (provider === 'custom') {
    const url = baseUrl ?? getProviderConfig('custom')?.baseUrl;
    if (!url) throw new Error('Provider "custom" requires a base URL — pass --base-url <url>.');
    if (!modelId) throw new Error('Provider "custom" requires a model id — pass --model <id>.');
    return buildCustomModel(modelId, url) as Model<string>;
  }
  if (provider === 'nvidia') {
    return buildNvidiaModel(modelId) as Model<string>;
  }
  if (provider === 'openrouter') {
    const registryModel = getModel('openrouter', modelId as never) as Model<string> | undefined;
    return registryModel ?? (buildOpenRouterModel(modelId) as Model<string>);
  }
  const registryModel = getModel(provider as KnownProvider, modelId as never) as Model<string>;
  if (!registryModel) {
    throw new Error(`Unknown model "${modelId}" for provider "${provider}".`);
  }
  return registryModel;
}

/**
 * Apply per-provider auth/headers to a stream's options. Providers pi-ai
 * doesn't recognize in its env-api-keys registry need an injected apiKey
 * (ollama needs a non-empty placeholder; NVIDIA needs `NVIDIA_API_KEY`);
 * openrouter gets the app-attribution headers.
 *
 * `primaryProvider` is the provider the Agent resolved `opts.apiKey` for. A
 * fallback model on a *different* provider can't reuse that key, so we resolve
 * its own env key instead.
 */
function withProviderAuth(
  model: Model<string>,
  opts: SimpleStreamOptions,
  primaryProvider: string,
): SimpleStreamOptions {
  const next: SimpleStreamOptions = { ...opts };
  if (model.provider !== primaryProvider) {
    next.apiKey = getEnvApiKey(model.provider as KnownProvider) || undefined;
  }
  if (model.provider === 'ollama') {
    next.apiKey = next.apiKey || 'ollama';
  } else if (model.provider === 'nvidia') {
    next.apiKey = next.apiKey || process.env.NVIDIA_API_KEY || '';
  } else if (model.provider === 'openrouter') {
    // Attribution headers list harnext on https://openrouter.ai/apps.
    // Caller-supplied headers win, so an embedder can re-attribute.
    next.headers = { ...openRouterAppHeaders(), ...opts.headers };
  } else if (model.provider === 'custom') {
    // Placeholder key is mandatory for keyless endpoints: pi-ai's client
    // throws on an empty key and would otherwise silently fall back to
    // $OPENAI_API_KEY — leaking the user's real OpenAI key to an
    // arbitrary URL.
    next.apiKey = next.apiKey || getProviderConfig('custom')?.key || 'custom';
  }
  return next;
}

export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  const provider = options.provider ?? 'anthropic';
  const modelId = options.modelId ?? '';
  const sessionApiKey = options.apiKey;
  const cwd = options.cwd ?? process.cwd();
  const thinkingLevel: ThinkingLevel = options.thinkingLevel ?? 'off';

  // Resume: seed prior history before building the Agent. Caller-supplied
  // `initialMessages` win (full client control); otherwise load the stored
  // transcript by id. A miss (unknown id) degrades gracefully to a fresh
  // session. `convertToLlm` keeps user/assistant/toolResult, so either source
  // is usable as-is on the next call.
  const stored = options.resumeSessionId ? loadSession(options.resumeSessionId, cwd) : undefined;
  const seededMessages = options.initialMessages ?? stored?.messages;
  const resumed = !!seededMessages && seededMessages.length > 0;
  const resolvedSessionId =
    options.resumeSessionId ?? stored?.sessionId ?? options.sessionId;

  // Resolve the primary model and, if configured, the availability-fallback
  // model (built once and captured in the streamFn closure below). The fallback
  // provider defaults to the primary so a bare `--fallback-model <id>` works.
  // `options.baseUrl` flows through to both so a custom/ollama fallback that
  // shares the endpoint resolves correctly (harmless for registry providers).
  const model: Model<string> = resolveModel(provider, modelId, options.baseUrl);
  const fallbackModel: Model<string> | undefined = options.fallback
    ? resolveModel(options.fallback.provider ?? provider, options.fallback.modelId, options.baseUrl)
    : undefined;

  // Background-shell manager: one per session, shared by the bash / bash_output
  // / kill_shell tools and torn down in session.dispose(). Background execution
  // is orthogonal to *which* tools the caller supplies, so creation is gated
  // only on the env switch — customizing the tool list no longer strips it.
  // Both foreground bash and background shells route through `executor`.
  const backgroundEnabled = process.env.HARNEXT_DISABLE_BACKGROUND_TASKS !== '1';
  const executor = options.executor;
  const execCwd = options.execCwd;
  const backgroundShells = backgroundEnabled
    ? new BackgroundShellManager(cwd, { executor, execCwd })
    : undefined;

  // Build tools. The defaults wire the executor + background trio; callers
  // compose on top via buildTools (transform), tools (full replace), and/or
  // toolOverrides (swap by name).
  const defaultTools = createCodingTools(cwd, { backgroundShells, executor, execCwd });
  let tools: Tool[];
  if (options.buildTools) {
    tools = [...options.buildTools(defaultTools)];
  } else if (options.tools) {
    tools = [...options.tools];
  } else {
    tools = defaultTools;
  }
  if (options.toolOverrides) {
    tools = applyToolOverrides(tools, options.toolOverrides);
  }
  const diagnostics: CreateAgentSessionResult['diagnostics'] = [];

  // A closed tool set yields exactly the resolved tools — no MCP servers (which
  // would spawn on the host, outside any sandbox) and no skill tool.
  const closedToolSet = options.closedToolSet === true;

  // MCP: merge user + project configs, load metadata cache, register proxy + direct tools.
  let mcpManager: McpServerManager | undefined;
  if (!options.mcpDisabled && !closedToolSet) {
    const initialMerged =
      options.mcpConfigOverride ?? loadMergedConfig(cwd).merged;
    // Late-binding config getter — re-reads merged config on every call so that
    // `harnext mcp add` within a session (or a background edit) is picked up by
    // the proxy tool without rebuilding the Agent.
    const getMergedConfig = options.mcpConfigOverride
      ? () => options.mcpConfigOverride!
      : () => loadMergedConfig(cwd).merged;
    const cache = options.mcpCacheOverride ?? loadMcpCache();
    mcpManager = new McpServerManager();
    if (initialMerged.settings?.idleTimeout)
      mcpManager.setGlobalIdleTimeout(initialMerged.settings.idleTimeout);

    // Always register the proxy tool when MCP is enabled, even if no servers
    // are configured yet — this lets `/mcp add` within a session surface new
    // servers immediately through the already-registered proxy.
    const proxyEnabled = !initialMerged.settings?.disableProxyTool;
    if (proxyEnabled) {
      tools.push(
        createMcpProxyTool({
          cwd,
          manager: mcpManager,
          getConfig: getMergedConfig,
          getCache: () => cache,
        }),
      );
    }
    const merged = initialMerged;

    const prefix = merged.settings?.toolPrefix ?? 'server';
    for (const [name, cfg] of Object.entries(merged.mcpServers)) {
      const direct = cfg.directTools ?? merged.settings?.directTools ?? false;
      const cached = cache.servers[name];
      if (!direct || !cached || !isServerCacheValid(cached, cfg)) continue;
      const toolList =
        direct === true ? cached.tools : cached.tools.filter((t) => (direct as string[]).includes(t.name));
      const existingNames = new Set(tools.map((t) => t.name));
      for (const tool of toolList) {
        const wrapped = wrapMcpToolAsAgentTool(name, tool, () => cfg, mcpManager, prefix);
        if (existingNames.has(wrapped.name)) {
          diagnosticsPush(diagnostics, 'skill', 'error', `mcp tool "${wrapped.name}" collides with existing tool; skipped`, '');
          continue;
        }
        tools.push(wrapped);
        existingNames.add(wrapped.name);
      }
    }

    // Eager-connect servers in the background; refresh their cache entries.
    const eagerManager = mcpManager;
    const eagerServers = Object.entries(merged.mcpServers).filter(
      ([, c]) => c.lifecycle === 'eager' || c.lifecycle === 'keep-alive',
    );
    for (const [name, cfg] of eagerServers) {
      void eagerManager
        .connect(name, cfg)
        .then(() => eagerManager.listTools(name, cfg))
        .then((fetched) => {
          saveMcpCache({
            servers: {
              [name]: {
                configHash: computeServerConfigHash(cfg),
                cachedAt: Date.now(),
                tools: fetched.map((t) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema,
                })),
              },
            },
          });
        })
        .catch((err) => {
          if (!options.quiet) {
            console.warn(`[harnext] mcp eager "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
    }
  }

  // Load skills from project-local + user-wide dirs. SDK callers can pre-load and pass in.
  // On first run, seed bundled starter skills into `~/.harnext/skills/` before loading.
  let skills: Skill[];
  if (options.skills) {
    skills = options.skills;
  } else {
    const seed = seedBuiltinSkills();
    for (const d of seed.diagnostics) {
      diagnostics.push({ source: 'seed', type: d.type, message: d.message, path: d.path });
      if (!options.quiet) {
        console.warn(`[harnext] seed ${d.type}: ${d.message} (${d.path})`);
      }
    }
    const { skills: loaded, diagnostics: skillDiagnostics } = loadSkills({ cwd });
    for (const d of skillDiagnostics) {
      diagnostics.push({ source: 'skill', type: d.type, message: d.message, path: d.path });
      if (!options.quiet) {
        console.warn(`[harnext] skill ${d.type}: ${d.message} (${d.path})`);
      }
    }
    skills = loaded;
  }

  // Register the `skill` tool whenever any model-invocable skill is available.
  // This gives the model an explicit affordance for "invoke a skill" — without
  // it, models tend to hallucinate the skill name as a tool call. Skipped for a
  // closed tool set or when explicitly disabled.
  const skillToolDisabled = closedToolSet || options.disableSkillTool === true;
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  if (!skillToolDisabled && visibleSkills.length > 0 && !tools.some((t) => t.name === 'skill')) {
    tools.push(createSkillTool(() => skills));
  }

  // Build system prompt: base (custom or default) + CLAUDE.md context selected
  // via setting_sources + any append_system_prompt text.
  let systemPrompt = buildSystemPrompt({
    cwd,
    customPrompt: options.systemPrompt,
    skills,
  });
  const projectContext = loadProjectContext({ cwd, settingSources: options.settingSources });
  if (projectContext) systemPrompt += projectContext;
  systemPrompt += buildMemorySection(cwd);
  if (options.appendSystemPrompt) systemPrompt += `\n\n${options.appendSystemPrompt}`;

  // Apply tool policy: disallow_tools removes tools from view; the permission
  // hook enforces allowed_tools / permission_mode at call time.
  const toolPolicy = {
    permissionMode: options.permissionMode,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
  };
  const visibleTools = filterTools(tools, toolPolicy);
  const beforeToolCall = createPermissionHook(toolPolicy);

  // Resolve compaction settings: defaults < settings.json < SDK options.
  // SDK options (`options.compaction`) win to give programmatic callers an
  // escape hatch over file-based config.
  const settings = loadSettings(cwd);
  const compactionEnabled =
    options.compaction === false ? false : settings.compaction.enabled;
  const compactionOptions: CompactionOptions = {
    reserveTokens: settings.compaction.reserveTokens,
    keepRecentTokens: settings.compaction.keepRecentTokens,
    ...(options.compaction === false ? {} : options.compaction ?? {}),
  };

  // Create the agent
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools: visibleTools,
    },
    beforeToolCall,
    convertToLlm,
    streamFn: async (m, ctx, opts) => {
      const baseOpts = (opts ?? {}) as SimpleStreamOptions;
      // --api-key / options.apiKey seeds the primary provider's key; a
      // cross-provider fallback resolves its own env key in withProviderAuth.
      const seededOpts =
        sessionApiKey !== undefined
          ? { ...baseOpts, apiKey: baseOpts.apiKey ?? sessionApiKey }
          : baseOpts;
      // Primary first, then the fallback model (if any). Each attempt gets its
      // own provider auth/headers. With no fallback this is a thin pass-through.
      const attempts: FallbackAttempt[] = [
        { model: m, opts: withProviderAuth(m, seededOpts, provider) },
      ];
      if (fallbackModel) {
        attempts.push({
          model: fallbackModel,
          opts: withProviderAuth(fallbackModel, seededOpts, provider),
        });
      }
      return streamWithFallback(ctx as Context, attempts, streamSimple);
    },
    toolExecution: 'parallel',
  });

  // Seed prior history when resuming (from initialMessages or the store).
  if (seededMessages && seededMessages.length > 0) {
    agent.state.messages = seededMessages;
  }

  // Wire compaction after the Agent exists so the transform can mutate
  // `agent.state.messages` directly when it triggers — pi-agent-core's
  // transformContext is otherwise transient (its return is used only for
  // the next LLM call, the persistent state.messages keeps growing).
  if (compactionEnabled) {
    agent.transformContext = createCompaction(agent, model, compactionOptions);
  }

  const session = new AgentSession(agent, {
    model,
    systemPrompt,
    tools: visibleTools,
    thinkingLevel,
    skills,
    mcpManager,
    backgroundShells,
    executor,
    maxTurns: options.maxTurns,
    sessionId: resolvedSessionId,
  });

  return { session, diagnostics, sessionId: session.sessionId, resumed };
}

/**
 * Swap tools by name: an override replaces a same-named tool in place, or is
 * appended when none exists. Order of the original list is preserved.
 */
function applyToolOverrides(tools: Tool[], overrides: Record<string, Tool>): Tool[] {
  const result = tools.map((t) => overrides[t.name] ?? t);
  const present = new Set(result.map((t) => t.name));
  for (const [name, tool] of Object.entries(overrides)) {
    if (!present.has(name)) result.push(tool);
  }
  return result;
}

function diagnosticsPush(
  diagnostics: CreateAgentSessionResult['diagnostics'],
  source: 'seed' | 'skill',
  type: string,
  message: string,
  path: string,
): void {
  diagnostics.push({ source, type, message, path });
}
