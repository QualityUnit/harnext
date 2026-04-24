import { describe, expect, it } from 'vitest';

import { loadPrompt, renderPrompt } from '../src/code-analysis/prompt-loader.js';

describe('loadPrompt', () => {
  it('loads the bundled tech-stack YAML and returns the parsed shape', () => {
    const p = loadPrompt('tech-stack');
    expect(p.id).toBe('tech-stack');
    expect(p.version).toBe(1);
    expect(p.variables).toEqual(
      expect.arrayContaining(['outputPath', 'sessionDir', 'cwd', 'schemaJson']),
    );
    expect(p.body).toContain('{{outputPath}}');
    expect(p.body).toContain('{{schemaJson}}');
  });
});

describe('renderPrompt', () => {
  const stub = {
    id: 'test',
    version: 1,
    variables: ['a', 'b'],
    body: 'hello {{a}}, goodbye {{b}}',
  };

  it('substitutes every declared variable', () => {
    expect(renderPrompt(stub, { a: 'one', b: 'two' })).toBe('hello one, goodbye two');
  });

  it('throws when a declared variable is not supplied', () => {
    expect(() => renderPrompt(stub, { a: 'one' } as Record<string, string>)).toThrow(
      /missing value for declared variable "b"/,
    );
  });

  it('throws when an extra variable is supplied', () => {
    expect(() =>
      renderPrompt(stub, { a: 'one', b: 'two', c: 'three' }),
    ).toThrow(/supplied variable "c" is not declared/);
  });

  it('throws when the body references an undeclared {{var}}', () => {
    const bad = {
      id: 'bad',
      version: 1,
      variables: ['a'],
      body: 'uses {{a}} and {{rogue}}',
    };
    expect(() => renderPrompt(bad, { a: 'x' })).toThrow(
      /body references undeclared variable "{{rogue}}"/,
    );
  });

  it('ignores surrounding whitespace in {{ var }} references', () => {
    const p = {
      id: 't',
      version: 1,
      variables: ['name'],
      body: '{{ name }} and {{name}}',
    };
    expect(renderPrompt(p, { name: 'X' })).toBe('X and X');
  });
});
