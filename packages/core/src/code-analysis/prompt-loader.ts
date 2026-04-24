/**
 * Loads the bundled prompt YAML files and renders them with `{{var}}`
 * substitution.
 *
 * Prompts are authored as `.yaml` files under
 * `packages/core/src/code-analysis/prompts/` and ship with the package
 * (mirroring the bundled-skills pattern in `packages/core/src/seed.ts:8`).
 * They are purely internal — the user never edits them, and there is no
 * per-project override layer.
 *
 * The renderer is intentionally dumb: no conditionals, no loops, no
 * partials. A `{{var}}` in the body must have a matching entry in the
 * file's `variables:` list, and every declared variable must be supplied
 * at render time. Mismatches throw so typos fail loud in tests.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

export type PromptId =
  | 'tech-stack'
  | 'risk-contract'
  | 'check-scripts'
  | 'stage-prompts'
  | 'project-skills';

export interface LoadedPrompt {
  id: string;
  version: number;
  /** Free-form one-liner for maintainers. */
  description?: string;
  variables: string[];
  /** Raw body with `{{var}}` placeholders still present. */
  body: string;
}

/**
 * Resolves the bundled prompts dir. `import.meta.url` points at
 * `dist/index.js` (tsup, `splitting: false`) so the prompts ship one
 * directory up at `<pkg>/src/code-analysis/prompts/` and are copied by
 * npm via the "files" entry in package.json.
 */
export function getBundledPromptsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From dist/index.js → ../src/code-analysis/prompts
  return join(here, '..', 'src', 'code-analysis', 'prompts');
}

/**
 * Resolve the YAML file for a prompt id. `import.meta.url` points at
 * different files under different build/run modes, so we probe a
 * handful of candidate paths and return the first one that exists.
 *
 *   1. `@harnext/core` installed or run from its own dist:
 *      `<core/dist/index.js>/../src/code-analysis/prompts/<id>.yaml`
 *      (the `src/code-analysis/prompts` dir ships via package.json's
 *      `files` field).
 *   2. vitest / source mode:
 *      `<core/src/code-analysis/prompt-loader.ts>/prompts/<id>.yaml`.
 *   3. CLI bundle with core inlined (`noExternal`):
 *      `<cli/dist/index.js>/prompts/<id>.yaml`
 *      (the CLI's tsup `onSuccess` copies the prompts dir alongside
 *      its dist).
 */
function resolvePromptFile(id: PromptId): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'src', 'code-analysis', 'prompts', `${id}.yaml`),
    join(here, 'prompts', `${id}.yaml`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `prompt "${id}" not found; looked in: ${candidates.join(', ')}`,
  );
}

export function loadPrompt(id: PromptId): LoadedPrompt {
  const file = resolvePromptFile(id);
  const raw = readFileSync(file, 'utf-8');
  const parsed = parseYaml(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`prompt "${id}" at ${file} did not parse as a YAML object`);
  }
  const idField = parsed.id;
  const version = parsed.version;
  const variables = parsed.variables;
  const body = parsed.prompt;

  if (typeof idField !== 'string' || idField.length === 0) {
    throw new Error(`prompt "${id}" at ${file} is missing string "id"`);
  }
  if (typeof version !== 'number') {
    throw new Error(`prompt "${id}" at ${file} is missing numeric "version"`);
  }
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error(`prompt "${id}" at ${file} is missing string "prompt"`);
  }
  if (!Array.isArray(variables) || !variables.every((v) => typeof v === 'string')) {
    throw new Error(
      `prompt "${id}" at ${file} must declare a "variables" list of strings`,
    );
  }

  return {
    id: idField,
    version,
    description:
      typeof parsed.description === 'string' ? parsed.description : undefined,
    variables: variables as string[],
    body,
  };
}

/**
 * Literal `{{var}}` replacement. Throws when:
 *  - A variable is declared but not supplied.
 *  - A variable is supplied but not declared.
 *  - The body references a `{{var}}` that isn't declared.
 */
export function renderPrompt(
  prompt: LoadedPrompt,
  vars: Record<string, string>,
): string {
  const declared = new Set(prompt.variables);
  const supplied = new Set(Object.keys(vars));

  for (const name of declared) {
    if (!supplied.has(name)) {
      throw new Error(
        `prompt "${prompt.id}": missing value for declared variable "${name}"`,
      );
    }
  }
  for (const name of supplied) {
    if (!declared.has(name)) {
      throw new Error(
        `prompt "${prompt.id}": supplied variable "${name}" is not declared`,
      );
    }
  }

  // Find any {{...}} references in the body and verify each is declared.
  const referenced = new Set<string>();
  const refPattern = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g;
  let match: RegExpExecArray | null;
  while ((match = refPattern.exec(prompt.body)) !== null) {
    referenced.add(match[1]);
  }
  for (const name of referenced) {
    if (!declared.has(name)) {
      throw new Error(
        `prompt "${prompt.id}": body references undeclared variable "{{${name}}}"`,
      );
    }
  }

  // Perform the substitution. Values are inserted verbatim.
  return prompt.body.replace(refPattern, (_full, name: string) => vars[name]);
}
