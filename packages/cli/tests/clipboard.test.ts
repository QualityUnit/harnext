import { describe, expect, it } from 'vitest';

import { formatImageSize, pickImageMime } from '../src/cli/clipboard.js';

describe('pickImageMime', () => {
  it('prefers png over other image types', () => {
    expect(pickImageMime('TIMESTAMP\nTARGETS\nimage/jpeg\nimage/png\ntext/plain')).toBe('image/png');
  });

  it('falls back to jpeg when png is absent', () => {
    expect(pickImageMime('TARGETS\nimage/jpeg\nUTF8_STRING')).toBe('image/jpeg');
  });

  it('returns the first image type when none are preferred', () => {
    expect(pickImageMime('image/tiff\nimage/bmp')).toBe('image/tiff');
  });

  it('ignores GNOME image/x-special file-copy markers', () => {
    expect(pickImageMime('TARGETS\nimage/x-special/gnome-copied-files\ntext/uri-list')).toBeNull();
  });

  it('returns null when the clipboard has no image targets', () => {
    expect(pickImageMime('TIMESTAMP\nTARGETS\ntext/plain\nUTF8_STRING')).toBeNull();
  });
});

describe('formatImageSize', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatImageSize(512)).toBe('512 B');
    expect(formatImageSize(2048)).toBe('2 KB');
    expect(formatImageSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
