/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

// brs-js is isomorphic (pure JS + pako, no node built-ins), so the node and web
// builds are identical source; we emit distinctly-named files to preserve the
// existing consumption model (index.js + detect-node, package.json browser/module
// fields). pako lives in devDependencies and is intentionally bundled in.
export default defineConfig({
  build: {
    target: 'es2020',
    sourcemap: true,
    // dist/ is emptied on each build; the "build"/"dist" scripts re-emit the
    // .d.ts files afterwards via `tsc --emitDeclarationOnly` (runs after vite).
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      name: 'BRS',
    },
    rollupOptions: {
      output: [
        // CommonJS build used by node (index.js -> dist.node.js)
        { format: 'cjs', entryFileNames: 'dist.node.js', exports: 'named' },
        // CommonJS build used by browser bundlers (package.json "browser")
        { format: 'cjs', entryFileNames: 'dist.web.js', exports: 'named' },
        // ES module build (package.json "module")
        { format: 'es', entryFileNames: 'dist.mjs' },
        // Standalone UMD build exposing a global `BRS` (<script> tag usage)
        { format: 'umd', name: 'BRS', entryFileNames: 'dist.js', exports: 'named' },
      ],
    },
  },
  // Tests import the TypeScript source directly (vitest transpiles on the fly),
  // so no build is required to run them.
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
