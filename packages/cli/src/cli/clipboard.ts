import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

/** Hard cap on a pasted image; larger images are rejected with a message. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface ClipboardImage {
  /** Base64-encoded image bytes (pi-ai stores images as base64, not URLs). */
  data: string;
  /** e.g. "image/png". */
  mimeType: string;
  /** Decoded size in bytes. */
  bytes: number;
}

/** Outcome of a clipboard read so the UI can message precisely. */
export type ClipboardImageResult =
  | { kind: 'image'; image: ClipboardImage }
  | { kind: 'too-large'; bytes: number }
  | { kind: 'none' };

async function runBuffer(cmd: string, args: string[]): Promise<Buffer | null> {
  try {
    const { stdout } = await pExecFile(cmd, args, {
      encoding: 'buffer',
      maxBuffer: MAX_IMAGE_BYTES + 1024 * 1024,
    });
    return stdout as unknown as Buffer;
  } catch {
    return null; // tool missing (ENOENT) or no matching clipboard content
  }
}

async function runText(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await pExecFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 });
    return typeof stdout === 'string' ? stdout : String(stdout);
  } catch {
    return null;
  }
}

async function which(cmd: string): Promise<boolean> {
  try {
    await pExecFile('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** Pick the best image mime-type from a whitespace/newline-separated target list. */
export function pickImageMime(targets: string): string | null {
  const list = targets
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  // image/x-special/* is GNOME's file-copy marker, not a raster image.
  const images = list.filter((t) => /^image\//.test(t) && !t.startsWith('image/x-special'));
  if (images.length === 0) return null;
  const prefer = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
  for (const p of prefer) if (images.includes(p)) return p;
  return images[0];
}

function toResult(buf: Buffer | null, mimeType: string): ClipboardImageResult {
  if (!buf || buf.length === 0) return { kind: 'none' };
  if (buf.length > MAX_IMAGE_BYTES) return { kind: 'too-large', bytes: buf.length };
  return {
    kind: 'image',
    image: { data: buf.toString('base64'), mimeType, bytes: buf.length },
  };
}

/** True if a clipboard tool is installed for the current platform. */
export async function hasClipboardTool(): Promise<boolean> {
  if (process.platform === 'linux') {
    return which(process.env.WAYLAND_DISPLAY ? 'wl-paste' : 'xclip');
  }
  if (process.platform === 'darwin') return which('pbpaste');
  if (process.platform === 'win32') return true;
  return false;
}

/** A platform-appropriate hint for installing a clipboard tool. */
export function clipboardInstallHint(): string {
  if (process.platform === 'linux') {
    return process.env.WAYLAND_DISPLAY
      ? 'install wl-clipboard (e.g. `sudo apt install wl-clipboard`) to paste images'
      : 'install xclip (e.g. `sudo apt install xclip`) to paste images';
  }
  if (process.platform === 'darwin') {
    return 'install pngpaste (e.g. `brew install pngpaste`) to paste images';
  }
  return 'a clipboard tool is required to paste images';
}

/** Read an image from the system clipboard, if one is present. */
export async function readClipboardImage(): Promise<ClipboardImageResult> {
  if (process.platform === 'linux') {
    if (process.env.WAYLAND_DISPLAY) {
      const types = (await runText('wl-paste', ['--list-types'])) ?? '';
      const mime = pickImageMime(types);
      if (!mime) return { kind: 'none' };
      return toResult(await runBuffer('wl-paste', ['--type', mime]), mime);
    }
    const targets =
      (await runText('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])) ?? '';
    const mime = pickImageMime(targets);
    if (!mime) return { kind: 'none' };
    return toResult(await runBuffer('xclip', ['-selection', 'clipboard', '-t', mime, '-o']), mime);
  }
  if (process.platform === 'darwin') {
    // pngpaste writes PNG bytes to stdout; exits non-zero when no image present.
    return toResult(await runBuffer('pngpaste', ['-']), 'image/png');
  }
  if (process.platform === 'win32') {
    const ps =
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
      '$i=[System.Windows.Forms.Clipboard]::GetImage(); ' +
      'if($i -ne $null){$m=New-Object System.IO.MemoryStream; ' +
      '$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png); ' +
      '[Console]::Out.Write([Convert]::ToBase64String($m.ToArray()))}';
    const out = await runText('powershell', ['-NoProfile', '-STA', '-Command', ps]);
    const data = out?.trim();
    if (!data) return { kind: 'none' };
    const bytes = Math.floor((data.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) return { kind: 'too-large', bytes };
    return { kind: 'image', image: { data, mimeType: 'image/png', bytes } };
  }
  return { kind: 'none' };
}

/** Read plain text from the system clipboard (the Ctrl+V fallback when no image). */
export async function readClipboardText(): Promise<string | null> {
  if (process.platform === 'linux') {
    if (process.env.WAYLAND_DISPLAY) return runText('wl-paste', ['--no-newline']);
    return runText('xclip', ['-selection', 'clipboard', '-o']);
  }
  if (process.platform === 'darwin') return runText('pbpaste', []);
  if (process.platform === 'win32') {
    return runText('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']);
  }
  return null;
}

/** Compact human-readable size for the attach confirmation line. */
export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
