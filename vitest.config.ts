import { defineConfig } from 'vitest/config';

/**
 * One test runner for the whole workspace.
 *
 * Root rather than per-package because the things worth testing here are pure
 * modules that happen to live on both sides of the client/server line -- the
 * URL parser and the noise gate are in the desktop app, the image header
 * parser and the permission matrix are in the server -- and three copies of a
 * runner config is three things to keep in step for no gain at this size.
 *
 * `environment: node` throughout, including for the desktop modules. Nothing
 * under test touches the DOM: `audio-levels.ts` exports an `audioContext()`
 * that does, but the gate and the meters it feeds are arithmetic over
 * Float32Array and are the part that has ever been wrong.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    // out/ and dist/ hold built copies of the same files; without this, every
    // test would be collected twice and the second copy would be stale.
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', 'release/**'],
  },
});
