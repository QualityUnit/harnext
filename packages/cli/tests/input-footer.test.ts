import { describe, expect, it } from 'vitest';

import { inputFooter, stripAnsi } from '../src/modes/interactive/render.js';

const base = { provider: 'openai', model: 'gpt-4o-mini', cwd: process.cwd() };

describe('inputFooter background-jobs chip', () => {
  it('shows a ⚙ chip with the running count when backgroundJobs > 0', () => {
    const out = stripAnsi(inputFooter({ ...base, backgroundJobs: 2 }));
    expect(out).toContain('⚙ 2');
  });

  it('omits the chip when there are no running jobs', () => {
    expect(stripAnsi(inputFooter({ ...base, backgroundJobs: 0 }))).not.toContain('⚙');
  });

  it('omits the chip when backgroundJobs is undefined', () => {
    expect(stripAnsi(inputFooter(base))).not.toContain('⚙');
  });
});

describe('inputFooter attached-images chip', () => {
  it('shows a 🖼 chip with the count when images are attached', () => {
    expect(stripAnsi(inputFooter({ ...base, attachedImages: 2 }))).toContain('🖼 2');
  });

  it('omits the chip when there are no attached images', () => {
    expect(stripAnsi(inputFooter({ ...base, attachedImages: 0 }))).not.toContain('🖼');
    expect(stripAnsi(inputFooter(base))).not.toContain('🖼');
  });
});
