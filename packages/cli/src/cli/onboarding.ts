import { createInterface } from 'node:readline';

import chalk from 'chalk';

import {
  DEFAULT_OLLAMA_BASE_URL,
  NVIDIA_DEFAULT_MODEL,
  getProviderById,
  getProviderConfig,
  getStoredKey,
  listNvidiaModels,
  listOllamaModels,
  normalizeOllamaBaseUrl,
  PROVIDERS,
  saveProviderConfig,
  saveProviderKey,
  setDefault,
  setProviderEnv,
} from '@harnext/core';
import type { ProviderInfo } from '@harnext/core';
import { selectModel } from './model-picker.js';
import { select } from './select.js';
import type { SelectItem } from './select.js';

/**
 * Resolve an API key for the given provider.
 * Returns the key if found (env var or stored), or undefined.
 */
export function resolveApiKey(provider: ProviderInfo): string | undefined {
  if (provider.envVar) {
    const envKey = process.env[provider.envVar];
    if (envKey) return envKey;
  }
  return getStoredKey(provider.id);
}

/**
 * Ensure the target provider is configured.
 * - For API-key providers: find a key in env or on disk, otherwise onboard.
 * - For local providers (ollama): require a stored baseUrl, otherwise onboard.
 */
export async function ensureAuth(
  requestedProvider: string,
  requestedModel: string,
): Promise<{ provider: string; model: string }> {
  const info = getProviderById(requestedProvider);

  if (info) {
    if (info.local) {
      if (getProviderConfig(info.id)?.baseUrl) {
        return { provider: requestedProvider, model: requestedModel };
      }
    } else {
      const key = resolveApiKey(info);
      if (key) {
        setProviderEnv(info, key);
        return { provider: requestedProvider, model: requestedModel };
      }
    }
  }

  for (const p of PROVIDERS) {
    if (p.local) {
      if (getProviderConfig(p.id)?.baseUrl) {
        return { provider: p.id, model: p.defaultModel };
      }
      continue;
    }
    const key = resolveApiKey(p);
    if (key) {
      setProviderEnv(p, key);
      return { provider: p.id, model: p.defaultModel };
    }
  }

  return runOnboarding();
}

async function runOnboarding(): Promise<{ provider: string; model: string }> {
  console.log();
  console.log(chalk.bold.cyan('Welcome to harnext!'));
  console.log(chalk.dim('No providers configured. Let\'s set one up.'));

  const provider = await selectOnboardingProvider();
  if (!provider) {
    console.log(chalk.dim('\n  No provider selected. Exiting.'));
    process.exit(0);
  }

  if (provider.local) {
    const { model } = await onboardLocalProvider(provider);
    setDefault(provider.id, model);
    return { provider: provider.id, model };
  }

  const key = await promptApiKey(provider);
  saveProviderKey(provider.id, key);
  setProviderEnv(provider, key);

  // NVIDIA: pi-ai's static registry doesn't list NIM models, so go through
  // the dedicated picker that hits NVIDIA's `/v1/models` endpoint.
  if (provider.id === 'nvidia') {
    const modelId = await onboardNvidiaModel(provider, key);
    setDefault(provider.id, modelId);
    console.log(chalk.green(`\n  Saved! Using ${provider.name} / ${modelId}\n`));
    return { provider: provider.id, model: modelId };
  }

  // Let the user pick a model now that we know the provider is reachable.
  // Fall back to the provider's default if the registry lookup fails or the user cancels.
  let modelId = provider.defaultModel;
  try {
    const picked = await selectModel(provider);
    if (picked) modelId = picked.id;
  } catch {
    // Ignore — fall back to default model.
  }

  setDefault(provider.id, modelId);
  console.log(chalk.green(`\n  Saved! Using ${provider.name} / ${modelId}\n`));
  return { provider: provider.id, model: modelId };
}

/**
 * NVIDIA NIM picker — fetches the live model list from `/v1/models`. If the
 * fetch fails (offline, bad key) we fall back to the curated default so the
 * user isn't blocked at onboarding; they can re-pick later via /model.
 */
async function onboardNvidiaModel(provider: ProviderInfo, apiKey: string): Promise<string> {
  let summaries;
  try {
    summaries = await listNvidiaModels(apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`  Could not fetch NVIDIA model list: ${message}`));
    console.log(chalk.dim(`  Falling back to ${NVIDIA_DEFAULT_MODEL}; pick another via /model.`));
    return provider.defaultModel;
  }
  if (summaries.length === 0) {
    console.log(chalk.yellow(`  NVIDIA returned no models for this key. Using ${NVIDIA_DEFAULT_MODEL}.`));
    return provider.defaultModel;
  }
  const items: SelectItem<string>[] = summaries.map((s) => ({
    label: s.id,
    value: s.id,
    hint: s.ownedBy,
  }));
  const picked = await select(items, {
    title: `Select an ${provider.name} model`,
    pageSize: 15,
  });
  return picked ?? summaries[0].id;
}

async function selectOnboardingProvider(): Promise<ProviderInfo | undefined> {
  const items: SelectItem<ProviderInfo>[] = PROVIDERS.map((p) => ({
    label: p.name,
    value: p,
    hint: p.defaultModel,
  }));

  return select(items, { title: 'Select a provider' });
}

async function promptApiKey(provider: ProviderInfo): Promise<string> {
  console.log();
  console.log(chalk.dim(`  Set ${provider.envVar} in your environment, or enter it now.`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<string>((resolve) => {
    const ask = () => {
      rl.question(chalk.cyan('  API key: '), (answer) => {
        const key = answer.trim();
        if (key.length > 0) {
          rl.close();
          resolve(key);
        } else {
          console.log(chalk.red('  Key cannot be empty'));
          ask();
        }
      });
    };
    ask();
  });
}

/**
 * Configure a local provider (ollama). Prompts for base URL, verifies it,
 * then lets the user pick one of the installed models.
 */
export async function onboardLocalProvider(provider: ProviderInfo): Promise<{ model: string }> {
  const defaultBaseUrl = provider.defaultBaseUrl ?? DEFAULT_OLLAMA_BASE_URL;
  const existing = getProviderConfig(provider.id)?.baseUrl;
  const baseUrl = await promptBaseUrl(provider.name, existing ?? defaultBaseUrl);

  saveProviderConfig(provider.id, { baseUrl });

  let models: string[] = [];
  try {
    const summaries = await listOllamaModels(baseUrl);
    models = summaries.map((m) => m.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`  Could not reach ${provider.name} at ${baseUrl}: ${message}`));
    console.log(chalk.dim('  Saved the URL anyway — you can pick a model later via /model.'));
    return { model: provider.defaultModel };
  }

  if (models.length === 0) {
    console.log(chalk.yellow(`  No models installed on ${provider.name}. Pull one with "ollama pull <name>".`));
    return { model: provider.defaultModel };
  }

  const picked = await select(
    models.map((id) => ({ label: id, value: id })),
    { title: `Select an ${provider.name} model`, pageSize: 15 },
  );

  const model = picked ?? models[0];
  console.log(chalk.green(`\n  Saved! Using ${provider.name} at ${baseUrl} / ${model}\n`));
  return { model };
}

function promptBaseUrl(providerName: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(chalk.cyan(`  ${providerName} base URL [${fallback}]: `), (answer) => {
      rl.close();
      const raw = answer.trim() || fallback;
      resolve(normalizeOllamaBaseUrl(raw));
    });
  });
}
