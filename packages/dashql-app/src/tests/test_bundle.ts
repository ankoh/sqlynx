// This module is imported only after Mocha and the Vitest compatibility globals are installed.
// Eager imports let Vite combine the full suite instead of creating a serial request waterfall.
// Register the only engine-restart coverage first, before other tests retain Wasm runtimes.
import '../platform/hyperdb/hyperdb_wasm.integration.test.js';
import.meta.glob([
    '../**/*.test.{ts,tsx}',
    // Core tests now belong to the independent package, including stale Bazel outputs.
    '!../core/**',
    '!../platform/hyperdb/hyperdb_wasm.integration.test.ts',
], { eager: true });
