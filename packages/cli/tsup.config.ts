import { defineConfig } from 'tsup';

// `noExternal` inlines @harnext/core into the CLI bundle, so at runtime
// `import.meta.url` for anything that used to resolve to a core path
// now points at `packages/cli/dist/index.js`. The core's bundled assets
// (built-in skills + code-analysis YAML prompts) don't ship alongside
// the CLI dist by default, so the prompt loader and bundled-skills
// helper can't find them. We mirror both directories into `dist/`
// after build — runtime resolution then finds them at
// `<dist>/skills/` and `<dist>/prompts/`.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  noExternal: [/@harnext\/core/],
  external: ['@modelcontextprotocol/sdk', 'cross-spawn'],
  banner: {
    js: '#!/usr/bin/env node',
  },
  onSuccess:
    'rm -rf dist/skills dist/prompts && ' +
    'cp -r ../core/skills dist/skills && ' +
    'cp -r ../core/src/code-analysis/prompts dist/prompts && ' +
    'cp ../core/src/pii/pii-masker.py dist/pii-masker.py',
});
