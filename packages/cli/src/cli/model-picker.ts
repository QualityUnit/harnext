import { createInterface } from 'node:readline';

import { getModels } from '@mariozechner/pi-ai';
import type { KnownProvider, Model } from '@mariozechner/pi-ai';
import chalk from 'chalk';

import {
  buildNvidiaModel,
  buildOllamaModel,
  DEFAULT_OLLAMA_BASE_URL,
  getProviderConfig,
  getStoredKey,
  listNvidiaModels,
  listOllamaModels,
  normalizeOllamaBaseUrl,
  PROVIDERS,
  saveProviderConfig,
  saveProviderKey,
  setProviderEnv,
} from '@harnext/core';
import type { ProviderInfo } from '@harnext/core';
import { select } from './select.js';
import type { SelectItem } from './select.js';

export interface ModelPickerResult {
  provider: string;
  model: Model<string>;
}

/**
 * Interactive model picker triggered by the /model slash command.
 * Uses arrow-key select boxes for provider and model selection.
 */
export async function pickModel(): Promise<ModelPickerResult | undefined> {
  const provider = await selectProvider();
  if (!provider) return undefined;

  if (provider.local) {
    return pickLocalModel(provider);
  }

  const hasKey = await ensureProviderKey(provider);
  if (!hasKey) return undefined;

  if (provider.id === 'nvidia') {
    return pickNvidiaModel(provider);
  }

  const model = await selectModel(provider);
  if (!model) return undefined;

  return { provider: provider.id, model };
}

// ── Provider selection ───────────────────────────────────────────────

async function selectProvider(): Promise<ProviderInfo | undefined> {
  const items: SelectItem<ProviderInfo>[] = PROVIDERS.map((p) => {
    const configured = p.local
      ? !!getProviderConfig(p.id)?.baseUrl
      : !!(p.envVar && process.env[p.envVar]) || !!getStoredKey(p.id);
    const tag = configured ? chalk.green(' ✓') : '';
    return {
      label: p.name + tag,
      value: p,
      hint: p.defaultModel,
    };
  });

  return select(items, { title: 'Select a provider' });
}

// ── Model selection (registry providers) ─────────────────────────────

export async function selectModel(provider: ProviderInfo): Promise<Model<string> | undefined> {
  let models: Model<string>[];
  try {
    models = getModels(provider.id as KnownProvider) as Model<string>[];
  } catch {
    console.log(chalk.red(`  No models found for ${provider.name}`));
    return undefined;
  }

  if (models.length === 0) {
    console.log(chalk.red(`  No models found for ${provider.name}`));
    return undefined;
  }

  const items: SelectItem<Model<string>>[] = models.map((m) => {
    const parts: string[] = [];
    const ctx = formatTokenCount(m.contextWindow);
    parts.push(ctx);
    if (m.reasoning) parts.push('reasoning');
    if (m.cost.input > 0) parts.push(`$${m.cost.input}/${m.cost.output}`);
    return {
      label: m.id,
      value: m,
      hint: parts.join('  '),
    };
  });

  return select(items, { title: `Select a model (${provider.name})`, pageSize: 15 });
}

// ── NVIDIA NIM flow (custom model list, fixed remote base URL) ───────

async function pickNvidiaModel(provider: ProviderInfo): Promise<ModelPickerResult | undefined> {
  const apiKey = process.env[provider.envVar] ?? getStoredKey(provider.id);
  if (!apiKey) {
    console.log(chalk.red(`  No API key configured for ${provider.name}.`));
    return undefined;
  }
  let modelIds: string[];
  try {
    const summaries = await listNvidiaModels(apiKey);
    modelIds = summaries.map((s) => s.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  Could not fetch NVIDIA model list: ${message}`));
    return undefined;
  }
  if (modelIds.length === 0) {
    console.log(chalk.yellow(`  ${provider.name} returned no models for this key.`));
    return undefined;
  }
  const picked = await select(
    modelIds.map((id) => ({ label: id, value: id })),
    { title: `Select a model (${provider.name})`, pageSize: 15 },
  );
  if (!picked) return undefined;
  return {
    provider: provider.id,
    model: buildNvidiaModel(picked) as Model<string>,
  };
}

// ── Local provider flow (ollama) ─────────────────────────────────────

async function pickLocalModel(provider: ProviderInfo): Promise<ModelPickerResult | undefined> {
  const existing = getProviderConfig(provider.id)?.baseUrl;
  const baseUrl = existing ?? (await promptBaseUrl(provider));
  if (!baseUrl) return undefined;

  if (!existing) {
    saveProviderConfig(provider.id, { baseUrl });
  }

  let modelIds: string[];
  try {
    const summaries = await listOllamaModels(baseUrl);
    modelIds = summaries.map((m) => m.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  Could not reach ${provider.name} at ${baseUrl}: ${message}`));
    return undefined;
  }

  if (modelIds.length === 0) {
    console.log(chalk.yellow(`  No models installed on ${provider.name}. Pull one with "ollama pull <name>".`));
    return undefined;
  }

  const picked = await select(
    modelIds.map((id) => ({ label: id, value: id })),
    { title: `Select a model (${provider.name})`, pageSize: 15 },
  );
  if (!picked) return undefined;

  return {
    provider: provider.id,
    model: buildOllamaModel(picked, baseUrl) as Model<string>,
  };
}

async function promptBaseUrl(provider: ProviderInfo): Promise<string | undefined> {
  const fallback = provider.defaultBaseUrl ?? DEFAULT_OLLAMA_BASE_URL;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string | undefined>((resolve) => {
    rl.question(chalk.cyan(`  ${provider.name} base URL [${fallback}]: `), (answer) => {
      rl.close();
      const raw = answer.trim() || fallback;
      resolve(normalizeOllamaBaseUrl(raw));
    });
  });
}

// ── Key prompt (registry providers) ──────────────────────────────────

async function ensureProviderKey(provider: ProviderInfo): Promise<boolean> {
  if (provider.envVar && process.env[provider.envVar]) return true;

  const stored = getStoredKey(provider.id);
  if (stored) {
    setProviderEnv(provider, stored);
    return true;
  }

  console.log();
  console.log(chalk.yellow(`  No API key found for ${provider.name}.`));
  if (provider.envVar) {
    console.log(chalk.dim(`  Set ${provider.envVar} or enter it now.`));
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<boolean>((resolve) => {
    rl.question(chalk.cyan('  API key (empty to cancel): '), (answer) => {
      rl.close();
      const key = answer.trim();
      if (!key) {
        resolve(false);
        return;
      }
      saveProviderKey(provider.id, key);
      setProviderEnv(provider, key);
      console.log(chalk.green('  Key saved.'));
      resolve(true);
    });
  });
}

// ── Utilities ────────────────────────────────────────────────────────

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M ctx`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k ctx`;
  return `${tokens} ctx`;
}
