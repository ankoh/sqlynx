import coreWasmUrl from '@ankoh/dashql-core/wasm?url';
import shellWasmUrl from '@ankoh/dashql-shell-wasm?url';
import { installSharedCoreTestPool } from './core_pool.js';

import {
    BROWSER_TEST_MESSAGE_SOURCE,
    type BrowserTestCase,
    type BrowserTestFrameEvent,
    type SerializedTestError,
} from './protocol.js';
import { BROWSER_TEST_FILES, getBrowserTestModule } from './test_modules.js';
import {
    loadBrowserMocha,
    type BrowserMocha,
    type BrowserMochaRunner,
    type BrowserMochaSuite,
    type BrowserMochaTest,
} from './mocha_browser.js';

const params = new URLSearchParams(location.search);
const requestedFiles = params.getAll('file');
const files = requestedFiles.length > 0 ? requestedFiles : BROWSER_TEST_FILES;

function serializeError(error: unknown): SerializedTestError {
    if (error instanceof Error) {
        return { message: error.message, name: error.name, stack: error.stack ?? null };
    }
    if (error && typeof error === 'object') {
        const value = error as { message?: unknown; name?: unknown; stack?: unknown };
        return {
            message: typeof value.message === 'string' ? value.message : String(error),
            name: typeof value.name === 'string' ? value.name : 'Error',
            stack: typeof value.stack === 'string' ? value.stack : null,
        };
    }
    return { message: String(error), name: 'Error', stack: null };
}

function send(event: BrowserTestFrameEvent): void {
    window.parent.postMessage({ source: BROWSER_TEST_MESSAGE_SOURCE, event }, location.origin);
}

function testFile(test: BrowserMochaTest): string {
    if (test.__dashqlFile) return test.__dashqlFile;
    let suite = test.parent;
    while (suite) {
        if (suite.__dashqlFile) return suite.__dashqlFile;
        suite = suite.parent;
    }
    return '<unknown>';
}

async function setupBrowserTestEnvironment(): Promise<void> {
    const globals = globalThis as typeof globalThis & {
        DASHQL_PRECOMPILED?: Promise<Uint8Array>;
        DASHQL_SHELL_PRECOMPILED?: Promise<Uint8Array>;
        __DASHQL_TEST_HYPERDB_CLIENT__?: typeof globalThis.__DASHQL_TEST_HYPERDB_CLIENT__;
        __DASHQL_TEST_SHARE_SHELL_MODULE__?: boolean;
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    const parent = window.parent as typeof window.parent & typeof globalThis;
    globals.DASHQL_PRECOMPILED = parent.DASHQL_PRECOMPILED ?? fetch(coreWasmUrl).then(response => response.bytes());
    globals.__DASHQL_TEST_CORE_FACTORY__ = parent.__DASHQL_TEST_CORE_FACTORY__;
    globals.__DASHQL_TEST_HYPERDB_CLIENT__ = parent.__DASHQL_TEST_HYPERDB_CLIENT__;
    installSharedCoreTestPool();
    globals.DASHQL_SHELL_PRECOMPILED = fetch(shellWasmUrl).then(response => response.bytes());
    globals.__DASHQL_TEST_SHARE_SHELL_MODULE__ = true;
    if (typeof ResizeObserver === 'undefined') {
        globals.ResizeObserver = class ResizeObserverMock {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
}

async function run(): Promise<void> {
    const tests = new Map(files.map(file => [file, new Map<string, BrowserTestCase>()]));
    const importFailures = new Map<string, SerializedTestError>();
    let mocha: BrowserMocha;
    let disposeHyperDBPool: (() => void) | null = null;
    try {
        await setupBrowserTestEnvironment();
        const { installSharedHyperDBTestPool } = await import('./hyperdb_pool.js');
        const hyperDBPool = installSharedHyperDBTestPool();
        disposeHyperDBPool = hyperDBPool.dispose;
        mocha = await loadBrowserMocha();
        mocha.setup({
            checkLeaks: false,
            failZero: true,
            reporter: BrowserBridgeReporter,
            timeout: 60_000,
            ui: 'bdd',
        });
        await import('./vitest_compat.js');
        if (requestedFiles.length === 0) {
            await import('./test_bundle.js');
        } else {
            await Promise.all(files.map(async file => {
                const load = getBrowserTestModule(file);
                if (!load) {
                    importFailures.set(file, serializeError(new Error(`Unknown browser test file: ${file}`)));
                    return;
                }
                try {
                    await load();
                } catch (error) {
                    importFailures.set(file, serializeError(error));
                }
            }));
        }
        await new Promise<void>(resolve => mocha.run(resolve));
        await disposeHyperDBPool();
        send({ type: 'run-end' });
    } catch (error) {
        try {
            globalThis.__DASHQL_TEST_RESET_CORE_INSTANCE__?.();
            disposeHyperDBPool?.();
        } catch {
            // Preserve the original runner failure.
        }
        const serialized = serializeError(error);
        for (const file of files) {
            send({
                type: 'file-end',
                result: { duration: 0, error: serialized, file, status: 'failed', tests: [] },
            });
        }
        send({ type: 'run-end' });
    }

    function BrowserBridgeReporter(runner: BrowserMochaRunner): void {
        const events = globalThis.Mocha.Runner.constants;
        const totals = new Map<string, number>();
        const testIds = new WeakMap<BrowserMochaTest, string>();
        const fileStartedAt = new Map<string, number>();
        const failed = new Set<string>();
        const started = new Set<string>();
        const reported = new Set<string>();
        forEachTest(test => {
            const file = testFile(test);
            const index = totals.get(file) ?? 0;
            totals.set(file, index + 1);
            testIds.set(test, `${file}\0${index}`);
        });

        runner.on(events.EVENT_SUITE_BEGIN, (suite: BrowserMochaSuite) => {
            const file = suite.__dashqlFile;
            if (!file || started.has(file)) return;
            started.add(file);
            fileStartedAt.set(file, performance.now());
            send({ type: 'file-start', file });
        });
        runner.on(events.EVENT_TEST_BEGIN, test => {
            const file = testFile(test);
            if (!started.has(file)) {
                started.add(file);
                fileStartedAt.set(file, performance.now());
                send({ type: 'file-start', file });
            }
            const titlePath = test.titlePath();
            const result: BrowserTestCase = {
                duration: null,
                error: null,
                id: testIds.get(test) ?? `${file}\0running\0${tests.get(file)?.size ?? 0}`,
                status: 'running',
                title: test.title,
                titlePath,
            };
            tests.get(file)?.set(result.id, result);
        });
        runner.on(events.EVENT_TEST_PASS, test => finishTest(test, 'passed'));
        runner.on(events.EVENT_TEST_PENDING, test => finishTest(test, 'skipped'));
        runner.on(events.EVENT_TEST_FAIL, (test, error) => {
            failed.add(testFile(test));
            finishTest(test, 'failed', error);
        });
        runner.on(events.EVENT_SUITE_END, (suite: BrowserMochaSuite) => {
            const file = suite.__dashqlFile;
            if (file) {
                globalThis.__DASHQL_TEST_RESET_CORE_INSTANCE__?.();
                reportFile(file);
            }
        });
        runner.on(events.EVENT_RUN_END, () => {
            for (const file of files) reportFile(file);
        });

        function reportFile(file: string): void {
            if (reported.has(file)) return;
            reported.add(file);
            const values = [...(tests.get(file)?.values() ?? [])];
            const error = importFailures.get(file) ?? null;
            const startedAt = fileStartedAt.get(file);
            const hasTests = (totals.get(file) ?? 0) > 0;
            send({
                type: 'file-end',
                result: {
                    duration: startedAt == null ? 0 : performance.now() - startedAt,
                    error: error ?? (hasTests ? null : serializeError(new Error(`No tests registered for ${file}`))),
                    file,
                    status: error == null && hasTests && !failed.has(file) ? 'passed' : 'failed',
                    tests: values,
                },
            });
        }

        function finishTest(test: BrowserMochaTest, status: BrowserTestCase['status'], error?: Error): void {
            const file = testFile(test);
            const titlePath = test.titlePath();
            const id = testIds.get(test) ?? `${file}\0failure\0${tests.get(file)?.size ?? 0}`;
            const result: BrowserTestCase = {
                duration: test.duration ?? null,
                error: error ? serializeError(error) : null,
                id,
                status,
                title: test.title,
                titlePath,
            };
            tests.get(file)?.set(id, result);
        }

        function forEachTest(visit: (test: BrowserMochaTest) => void): void {
            const walk = (suite: BrowserMochaSuite): void => {
                suite.tests.forEach(visit);
                suite.suites.forEach(walk);
            };
            walk(mocha.suite);
        }
    }
}

void run();
