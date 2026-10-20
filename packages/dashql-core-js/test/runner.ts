import mochaUrl from 'mocha/mocha.js?url';
import coreWasmUrl from './inputs/src/wasm/dashql_core.wasm?url';

const globals = globalThis as any;
const summary = globals.__DASHQL_BROWSER_TESTS__ = {
    status: 'running', files: [] as any[], passed: 0, failed: 0, skipped: 0, duration: 0,
};
const started = performance.now();
const modules = import.meta.glob(['./inputs/src/**/*.test.ts', './*.test.ts']);
const requestedFile = new URLSearchParams(location.search).get('file');
const files = requestedFile
    ? [requestedFile.startsWith('src/') ? `./inputs/${requestedFile}` : `./${requestedFile}`]
    : Object.keys(modules).sort();
function serializeError(error: any) {
    return { message: error?.message ?? String(error), stack: error?.stack ?? null };
}

async function run(): Promise<void> {
    const script = document.createElement('script');
    script.src = mochaUrl;
    await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load Mocha from ${mochaUrl}`));
        document.head.append(script);
    });
    globals.mocha.setup({ ui: 'bdd', timeout: 60_000, checkLeaks: false, reporter: function SilentReporter() {} });
    const { setTestFile } = await import('./vitest_compat.js');
    // Fixtures may reuse a runtime, but the production factory never reads test globals.
    const { DashQL } = await import('./inputs/src/api.js');
    const create = DashQL.create.bind(DashQL);
    globals.DASHQL_PRECOMPILED = fetch(coreWasmUrl).then(async response => {
        if (!response.ok) throw new Error(`Failed to fetch core Wasm: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
    });
    const wasmModule = await WebAssembly.compile((await globals.DASHQL_PRECOMPILED).slice().buffer);
    let instance: Promise<InstanceType<typeof DashQL>> | undefined;
    let resolvedInstance: InstanceType<typeof DashQL> | undefined;
    DashQL.create = async (options = {}) => {
        instance ??= create({
            ...options,
            wasmBinary: undefined,
            module: options.module ?? wasmModule,
        });
        return resolvedInstance = await instance;
    };
    const results = new Map<string, any>();
    for (const path of files) {
        const result = { file: path.replace(/^\.\/(inputs\/)?/, ''), status: 'running', tests: [] as any[], error: null as any, duration: 0 };
        summary.files.push(result);
        results.set(result.file, result);
        try {
            const load = modules[path];
            if (!load) throw new Error(`Unknown browser test file: ${result.file}`);
            setTestFile(result.file);
            await load();
        } catch (error) {
            result.error = serializeError(error);
            result.status = 'failed';
            summary.failed++;
        }
    }
    if (files.length === 0) throw new Error('No core browser test files found');
    await new Promise<void>(resolve => {
        const runner = globals.mocha.run(resolve);
        runner.on('test', (test: any) => {
            globals.__DASHQL_BROWSER_TESTS__.activeTest = test.titlePath().join(' > ');
        });
        runner.on('suite', (suite: any) => {
            const result = results.get(suite.__dashqlFile);
            if (result) result.started = performance.now();
        });
        for (const [event, status] of [['pass', 'passed'], ['fail', 'failed'], ['pending', 'skipped']]) {
            runner.on(event, (test: any, error: any) => {
                let suite = test.parent;
                while (suite && !suite.__dashqlFile) suite = suite.parent;
                const result = results.get(suite?.__dashqlFile);
                if (!result) throw new Error('Test registered outside a file suite');
                result.tests.push({ titlePath: test.titlePath(), status, error: error ? serializeError(error) : null });
                summary[status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'skipped']++;
            });
        }
        // The reset is synchronous: Mocha starts the next file immediately after this event.
        runner.on('suite end', (suite: any) => {
            const result = results.get(suite.__dashqlFile);
            if (!result) return;
            resolvedInstance?.resetUnsafe();
            result.duration = performance.now() - result.started;
        });
    });
    for (const result of results.values()) {
        if (result.error) continue;
        if (result.tests.length === 0) {
            result.error = serializeError(new Error(`No tests registered for ${result.file}`));
            summary.failed++;
        }
        result.status = result.error || result.tests.some((test: any) => test.status === 'failed') ? 'failed' : 'passed';
    }
}

void run().catch(error => {
    summary.failed++;
    summary.files.push({ file: '<harness>', status: 'failed', tests: [], error: serializeError(error) });
}).finally(() => {
    summary.duration = performance.now() - started;
    summary.status = summary.failed > 0 ? 'failed' : 'passed';
    document.getElementById('results')!.textContent = JSON.stringify(summary, null, 2);
});
