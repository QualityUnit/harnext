import { parse } from 'yaml';

export interface ParsedFrontmatter<T extends Record<string, unknown>> {
  frontmatter: T;
  body: string;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function extractFrontmatter(content: string): { yamlString: string | null; body: string } {
  const normalized = normalizeNewlines(content);

  if (!normalized.startsWith('---')) {
    return { yamlString: null, body: normalized };
  }

  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { yamlString: null, body: normalized };
  }

  return {
    yamlString: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 4).trim(),
  };
}

export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): ParsedFrontmatter<T> {
  const { yamlString, body } = extractFrontmatter(content);
  if (!yamlString) {
    return { frontmatter: {} as T, body };
  }
  const parsed = parse(yamlString);
  return { frontmatter: (parsed ?? {}) as T, body };
}
