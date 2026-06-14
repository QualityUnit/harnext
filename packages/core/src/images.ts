import { readFile } from 'node:fs/promises';

import type { ImageContent } from '@earendil-works/pi-ai';

export type { ImageContent } from '@earendil-works/pi-ai';

/**
 * An image accepted by the programmatic SDK. pi-ai only transports base64, so a
 * URL / data-URI / file path is fetched and encoded by {@link resolveImages}.
 *
 *   - `ImageContent`        — already base64: `{ type:'image', data, mimeType }`
 *   - `{ url, mimeType? }`  — http(s):// URL, `data:` URI, or local file path
 *   - `string`             — shorthand for `{ url: <string> }`
 */
export type ImageInput =
  | ImageContent
  | { url: string; mimeType?: string }
  | string;

/** Max image size accepted from a URL/file (decoded bytes). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
};

function inferMimeFromPath(s: string): string | undefined {
  // Strip query/hash for URLs, then take the extension.
  const clean = s.split(/[?#]/)[0] ?? s;
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXT_MIME[clean.slice(dot + 1).toLowerCase()];
}

function parseDataUri(url: string): ImageContent {
  // data:[<mediatype>][;base64],<data>
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) throw new Error('Malformed data: URI for image');
  const [, mediatype, base64Flag, payload] = match;
  if (!base64Flag) {
    throw new Error('Only base64 data: URIs are supported for images');
  }
  return {
    type: 'image',
    mimeType: mediatype || 'image/png',
    data: payload.replace(/\s/g, ''),
  };
}

async function fetchImage(url: string, mimeHint?: string): Promise<ImageContent> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Failed to fetch image from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch image from ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`Fetched image from ${url} is empty`);
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image from ${url} exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  }
  const contentType = res.headers.get('content-type')?.split(';')[0]?.trim();
  const mimeType =
    mimeHint ||
    (contentType && contentType.startsWith('image/') ? contentType : undefined) ||
    inferMimeFromPath(url) ||
    'image/png';
  return { type: 'image', data: buf.toString('base64'), mimeType };
}

async function readImageFile(path: string, mimeHint?: string): Promise<ImageContent> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    throw new Error(`Failed to read image file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image file ${path} exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  }
  return {
    type: 'image',
    data: buf.toString('base64'),
    mimeType: mimeHint || inferMimeFromPath(path) || 'image/png',
  };
}

/** Resolve one image input into a base64 {@link ImageContent}. */
export async function resolveImage(input: ImageInput): Promise<ImageContent> {
  if (typeof input === 'string') return resolveUrl(input);
  if ('url' in input) return resolveUrl(input.url, input.mimeType);
  if (input.type === 'image' && typeof input.data === 'string') return input; // already base64
  throw new Error('Unrecognized image input');
}

function resolveUrl(url: string, mimeHint?: string): Promise<ImageContent> {
  if (url.startsWith('data:')) return Promise.resolve(parseDataUri(url));
  if (/^https?:\/\//i.test(url)) return fetchImage(url, mimeHint);
  return readImageFile(url, mimeHint); // treat anything else as a local path
}

/**
 * Resolve mixed image inputs (base64 / URL / data-URI / file path) into the
 * base64 {@link ImageContent}[] that pi-ai transports. Used by
 * `AgentSession.prompt(text, images)`.
 */
export function resolveImages(inputs: ImageInput[]): Promise<ImageContent[]> {
  return Promise.all(inputs.map(resolveImage));
}
