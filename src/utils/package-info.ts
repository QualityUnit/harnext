import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build-time constants injected by tsup define in the release bundle.
// In dev/test these remain undefined; the function falls through to the
// directory-walk logic below.
declare const __CODEFACTORY_VERSION__: string | undefined;
declare const __CODEFACTORY_DESCRIPTION__: string | undefined;

export interface PackageInfo {
  version: string;
  description: string;
}

/**
 * Read package.json by walking up from the current file's directory.
 * Works both in source (src/) and bundled (dist/) contexts.
 * In standalone release binaries, build-time constants are used instead.
 */
export function getPackageInfo(): PackageInfo {
  // In the release bundle, tsup replaces these with string literals.
  if (typeof __CODEFACTORY_VERSION__ === 'string' && __CODEFACTORY_VERSION__ !== '') {
    return {
      version: __CODEFACTORY_VERSION__,
      description:
        typeof __CODEFACTORY_DESCRIPTION__ === 'string' ? __CODEFACTORY_DESCRIPTION__ : '',
    };
  }

  let dir = dirname(fileURLToPath(import.meta.url));

  while (true) {
    try {
      const content = readFileSync(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(content) as Record<string, unknown>;
      if (typeof pkg.version === 'string') {
        return {
          version: pkg.version,
          description: typeof pkg.description === 'string' ? pkg.description : '',
        };
      }
    } catch {
      // Not found at this level, continue up
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { version: '0.0.0', description: '' };
}
