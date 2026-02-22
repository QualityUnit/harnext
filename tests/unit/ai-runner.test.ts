import { extractJson } from '../../src/core/ai-runner.js';

describe('extractJson', () => {
  it('should extract JSON from markdown code fences with json tag', () => {
    const input = '```json\n{"count": 42}\n```';
    expect(extractJson(input)).toBe('{"count": 42}');
  });

  it('should extract JSON from markdown code fences without tag', () => {
    const input = '```\n{"key": "value"}\n```';
    expect(extractJson(input)).toBe('{"key": "value"}');
  });

  it('should extract JSON object from surrounding text', () => {
    const input = 'Here is the result: {"name": "test"} and some trailing text';
    expect(extractJson(input)).toBe('{"name": "test"}');
  });

  it('should extract JSON array from surrounding text', () => {
    const input = 'Results: [1, 2, 3] done';
    expect(extractJson(input)).toBe('[1, 2, 3]');
  });

  it('should return trimmed text when no JSON or fences found', () => {
    const input = '  just plain text  ';
    expect(extractJson(input)).toBe('just plain text');
  });

  it('should handle multiline JSON inside fences', () => {
    const input = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';
    const result = extractJson(input);
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
  });

  it('should prefer code fence extraction over bare JSON', () => {
    const input = 'prefix {"outer": true} ```json\n{"inner": true}\n``` suffix';
    expect(extractJson(input)).toBe('{"inner": true}');
  });

  it('should handle already-clean JSON input', () => {
    const input = '{"clean": true}';
    expect(extractJson(input)).toBe('{"clean": true}');
  });

  it('should not greedily match across multiple JSON objects', () => {
    const input = 'first: {"a": 1} then second: {"b": 2}';
    const result = extractJson(input);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it('should handle nested JSON objects correctly', () => {
    const input = 'result: {"a": {"b": 1}, "c": 2}';
    const result = extractJson(input);
    expect(JSON.parse(result)).toEqual({ a: { b: 1 }, c: 2 });
  });

  it('should handle nested arrays and objects', () => {
    const input = '{"items": [{"id": 1}, {"id": 2}], "total": 2}';
    const result = extractJson(input);
    expect(JSON.parse(result)).toEqual({ items: [{ id: 1 }, { id: 2 }], total: 2 });
  });

  it('should handle braces inside JSON strings', () => {
    const input = '{"msg": "use {braces} here", "ok": true}';
    const result = extractJson(input);
    expect(JSON.parse(result)).toEqual({ msg: 'use {braces} here', ok: true });
  });

  it('should handle escaped quotes inside JSON strings', () => {
    const input = '{"msg": "say \\"hello\\"", "ok": true}';
    const result = extractJson(input);
    expect(JSON.parse(result)).toEqual({ msg: 'say "hello"', ok: true });
  });
});
