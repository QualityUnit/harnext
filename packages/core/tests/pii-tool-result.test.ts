import { describe, expect, it } from 'vitest';

import { maskToolResultContent } from '../src/pii/masker.js';
import type { PiiMasker, MaskResult } from '../src/pii/masker.js';

// Stub masker that wraps every word containing a digit as `[DIGIT]` — enough to
// prove the helper substitutes text-block content while leaving non-text blocks
// untouched, without pulling in transformers.js or downloading the real model.
function stubMasker(): PiiMasker {
  return {
    ready: async () => undefined,
    mask: async (text: string): Promise<MaskResult> => ({
      masked: text.replace(/\b\w*\d\w*\b/g, '[DIGIT]'),
      entities: [],
    }),
    dispose: () => undefined,
  };
}

describe('maskToolResultContent', () => {
  it('masks text blocks and leaves non-text blocks intact', async () => {
    const content = [
      { type: 'text' as const, text: 'phone 555-1234, name John' },
      { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' },
      { type: 'text' as const, text: 'no digits here' },
    ];
    const out = await maskToolResultContent(content, stubMasker());
    expect(out[0]).toEqual({ type: 'text', text: 'phone [DIGIT]-[DIGIT], name John' });
    expect(out[1]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
    expect(out[2]).toEqual({ type: 'text', text: 'no digits here' });
  });

  it('returns a new array without mutating the input', async () => {
    const block = { type: 'text' as const, text: 'card 4242-1111' };
    const content = [block];
    const out = await maskToolResultContent(content, stubMasker());
    expect(block.text).toBe('card 4242-1111');
    expect(out[0].text).toBe('card [DIGIT]-[DIGIT]');
    expect(out).not.toBe(content);
  });
});
