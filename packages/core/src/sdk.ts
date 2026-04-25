import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core';
import { getModel, streamSimple } from '@mariozechner/pi-ai';
import type { KnownProvider, Message, Model } from '@mariozechner/pi-ai';

import { AgentSession } from './agent-session.js';
import { getProviderConfig } from './auth.js';
import { createCompaction } from './compaction.js';
import type { CompactionOptions } from './compaction.js';
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
import { buildOllamaModel, DEFAULT_OLLAMA_BASE_URL } from './ollama.js';
import { seedBuiltinSkills } from './seed.js';
import { loadSkills, type Skill } from './skills.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createCodingTools, createSkillTool, type Tool } from './tools/index.js';

export { createCodingTools, createAllTools, createBashTool, createReadTool, createEditTool, createWriteTool, createSkillTool } from './tools/index.js';

export interface CreateAgentSessionOptions {
  /** LLM provider name */
  provider?: string;
  /** Model ID within the provider */
  modelId?: string;
  /** Working directory for tools */
  cwd?: string;
  /** Override the system prompt */
  systemPrompt?: string;
  /** Thinking/reasoning level */
  thinkingLevel?: ThinkingLevel;
  /** Custom tools (overrides default coding tools) */
  tools?: Tool[];
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
}

export interface CreateAgentSessionResult {
  session: AgentSession;
  /**
   * Seed + skill-loading diagnostics emitted while building the session. When
   * `quiet: true` this is the only way to observe them.
   */
  diagnostics: Array<{ source: 'seed' | 'skill'; type: string; message: string; path: string }>;
}

function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  ) as Message[];
}

export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  const provider = options.provider ?? 'anthropic';
  const modelId = options.modelId ?? '';
  const cwd = options.cwd ?? process.cwd();
  const thinkingLevel: ThinkingLevel = options.thinkingLevel ?? 'off';

  // Resolve model: ollama uses a custom Model built from stored baseUrl;
  // all other providers come from the pi-ai registry.
  let model: Model<string>;
  if (provider === 'ollama') {
    const baseUrl = getProviderConfig('ollama')?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
    model = buildOllamaModel(modelId, baseUrl) as Model<string>;
  } else {
    const registryModel = getModel(provider as KnownProvider, modelId as never) as Model<string>;
    if (!registryModel) {
      throw new Error(`Unknown model "${modelId}" for provider "${provider}".`);
    }
    model = registryModel;
  }

  // Build tools
  const tools: Tool[] = options.tools ? [...options.tools] : createCodingTools(cwd);
  const diagnostics: CreateAgentSessionResult['diagnostics'] = [];

  // MCP: merge user + project configs, load metadata cache, register proxy + direct tools.
  let mcpManager: McpServerManager | undefined;
  if (!options.mcpDisabled) {
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
  // it, models tend to hallucinate the skill name as a tool call.
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  if (visibleSkills.length > 0 && !tools.some((t) => t.name === 'skill')) {
    tools.push(createSkillTool(() => skills));
  }

  // Build system prompt
  const systemPrompt = buildSystemPrompt({
    cwd,
    customPrompt: options.systemPrompt,
    skills,
  });

  // Set up compaction (enabled by default)
  const transformContext =
    options.compaction !== false ? createCompaction(model, options.compaction ?? {}) : undefined;

  // Create the agent
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools,
    },
    convertToLlm,
    transformContext,
    streamFn: async (m, ctx, opts) => {
      // Ollama needs a non-empty API key placeholder for the OpenAI-compatible client.
      const finalOpts = m.provider === 'ollama' ? { ...opts, apiKey: opts?.apiKey ?? 'ollama' } : opts;
      return streamSimple(m, ctx, finalOpts);
    },
    toolExecution: 'parallel',
  });

  const session = new AgentSession(agent, {
    model,
    systemPrompt,
    tools,
    thinkingLevel,
    skills,
    mcpManager,
  });

  return { session, diagnostics };
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
