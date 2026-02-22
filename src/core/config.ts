import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileExists } from '../utils/fs.js';

export interface HarnessConfig {
  version: string;
  repoRoot: string;
  detection: {
    primaryLanguage: string;
    framework: string | null;
    packageManager: string | null;
    ciProvider: string | null;
    monorepo: boolean;
  };
  harnesses: {
    name: string;
    enabled: boolean;
    generatedAt: string;
    files: string[];
  }[];
  generatedAt: string;
  lastUpdated: string;
}

const CONFIG_FILENAME = 'harness.config.json';

export async function loadHarnessConfig(repoRoot: string): Promise<HarnessConfig | null> {
  const configPath = join(repoRoot, CONFIG_FILENAME);
  if (!(await fileExists(configPath))) {
    return null;
  }

  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as HarnessConfig;
  } catch {
    return null;
  }
}

export async function saveHarnessConfig(repoRoot: string, config: HarnessConfig): Promise<void> {
  const configPath = join(repoRoot, CONFIG_FILENAME);
  await mkdir(dirname(configPath), { recursive: true });
  config.lastUpdated = new Date().toISOString();
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
