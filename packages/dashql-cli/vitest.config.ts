import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        // hyperdb-wasm uses wasm exception references, which the Node 24.4 toolchain has behind a flag
        execArgv: ["--experimental-wasm-exnref"],
        include: ["src/**/*.test.ts"],
        maxWorkers: 1,
        hookTimeout: 30000,
        testTimeout: 30000,
    },
});
