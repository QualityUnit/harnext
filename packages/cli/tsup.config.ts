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
  // `@huggingface/transformers` and `onnxruntime-node` ship native binaries
  // (the ORT C++ runtime) loaded via prebuilt .node files at runtime — bundling
  // them through tsup would break the dynamic require + asset-resolution paths.
  // They're listed in cli/package.json so npm install pulls them at install time.
  external: [
    '@modelcontextprotocol/sdk',
    'cross-spawn',
    '@huggingface/transformers',
    'onnxruntime-node',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
  onSuccess:
    'rm -rf dist/skills dist/prompts && ' +
    'cp -r ../core/skills dist/skills && ' +
    'cp -r ../core/src/code-analysis/prompts dist/prompts',
});
