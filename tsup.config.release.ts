import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

// Read runtime dependency names from package.json to bundle them into the
// standalone release binary.
const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
};
const runtimeDeps = Object.keys(pkg.dependencies ?? {});

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  noExternal: runtimeDeps,
  define: {
    __CODEFACTORY_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
    __CODEFACTORY_DESCRIPTION__: JSON.stringify(pkg.description ?? ''),
  },
  banner: {
    // Shebang + createRequire shim: CJS packages bundled into ESM (e.g.
    // commander) call require('events') etc. In ESM there is no require
    // function, so we create one from import.meta.url.
    js: '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
  },
});
