export const BROWSER_TEST_MODULES = import.meta.glob([
    '../**/*.test.{ts,tsx}',
    // Also exclude stale copy_to_bin outputs left behind by the core extraction.
    '!../core/**',
]);

function normalizePath(path: string): string {
    return path.replace(/^\.\.\//, 'src/');
}

export const BROWSER_TEST_FILES = Object.keys(BROWSER_TEST_MODULES)
    .map(normalizePath)
    .sort();

export const BLOCKED_BROWSER_TEST_FILES: readonly string[] = [];

export function getBrowserTestModule(file: string): (() => Promise<unknown>) | null {
    return BROWSER_TEST_MODULES[`../${file.replace(/^src\//, '')}`] ?? null;
}
