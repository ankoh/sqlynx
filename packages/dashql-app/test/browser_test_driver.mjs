import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const playwright = await import('playwright-core');

const root = resolve(process.argv[2]);
const requestedFile = process.argv[3] ?? '';
const timeout = Number.parseInt(process.env.DASHQL_BROWSER_TEST_TIMEOUT ?? '600000', 10);
const browserName = process.env.DASHQL_BROWSER ?? 'chromium';
const browserType = playwright[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
const executableRoot = process.env.DASHQL_BROWSER_EXECUTABLE_ROOT;
const executablePath = executableRoot
    ? join(executableRoot, process.platform === 'darwin' ? 'firefox/Nightly.app/Contents/MacOS/firefox' : 'firefox/firefox')
    : process.env.DASHQL_BROWSER_EXECUTABLE;

const mimeTypes = {
    '.br': 'application/octet-stream',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
};

const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1));
    const file = resolve(join(root, relative));
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
    }
    try {
        if (!statSync(file).isFile()) throw new Error('Not a file');
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream',
        };
        if (file.endsWith('.br')) {
            headers['Content-Encoding'] = 'br';
            headers['Content-Type'] = 'application/wasm';
        }
        response.writeHead(200, headers);
        createReadStream(file).pipe(response);
    } catch {
        response.writeHead(404).end('Not found');
    }
});

await new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListening);
});

const address = server.address();
if (!address || typeof address === 'string') throw new Error('Static server did not bind a TCP port');
const browser = await browserType.launch({
    // Firefox resolves XPCOM resources relative to the physical app bundle, not a runfiles symlink.
    executablePath: realpathSync(executablePath),
    headless: true,
});

try {
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('console', message => {
        if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('pageerror', error => browserErrors.push(error.stack ?? error.message));

    const query = new URLSearchParams({ autorun: '1' });
    if (requestedFile) query.set('file', requestedFile);
    await page.goto(`http://127.0.0.1:${address.port}/tests.html?${query}`, { waitUntil: 'domcontentloaded' });
    try {
        await page.waitForFunction(() => globalThis.__DASHQL_BROWSER_TESTS__?.status === 'running', null, { timeout: 30_000 });
    } catch (error) {
        const current = await page.evaluate(() => globalThis.__DASHQL_BROWSER_TESTS__);
        console.error(`Browser test run did not start; current status: ${current?.status ?? 'unavailable'}`);
        if (browserErrors.length > 0) console.error(`\nBrowser errors:\n${browserErrors.join('\n')}`);
        throw error;
    }
    try {
        await page.waitForFunction(() => {
            const status = globalThis.__DASHQL_BROWSER_TESTS__?.status;
            return status === 'passed' || status === 'failed';
        }, null, { timeout });
    } catch (error) {
        const current = await page.evaluate(() => globalThis.__DASHQL_BROWSER_TESTS__);
        const running = current?.files.find(file => file.status === 'running');
        console.error(`Timed out with ${current?.passed ?? 0} passed and ${current?.failed ?? 0} failed; active file: ${running?.file ?? 'none'}`);
        if (browserErrors.length > 0) console.error(`\nBrowser errors:\n${browserErrors.join('\n')}`);
        throw error;
    }

    // V8 stacks start with the error message, Firefox stacks only list frames.
    const formatError = error => {
        if (!error) return 'Failed';
        const header = `${error.name ?? 'Error'}: ${error.message ?? ''}`;
        if (!error.stack) return header;
        return error.stack.startsWith(header) ? error.stack : `${header}\n${error.stack}`;
    };
    const summary = await page.evaluate(() => globalThis.__DASHQL_BROWSER_TESTS__);
    const failures = summary.files.flatMap(file => {
        const fileFailure = file.error ? [`${file.file}\n${formatError(file.error)}`] : [];
        const testFailures = file.tests
            .filter(test => test.status === 'failed')
            .map(test => `${file.file}: ${test.titlePath.join(' > ')}\n${formatError(test.error)}`);
        return [...fileFailure, ...testFailures];
    });

    console.log(`${summary.files.length} files, ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped in ${(summary.duration / 1000).toFixed(2)}s`);
    if (failures.length > 0) console.error(`\n${failures.join('\n\n')}`);
    if (browserErrors.length > 0) console.error(`\nBrowser errors:\n${browserErrors.join('\n')}`);
    if (summary.status !== 'passed' || browserErrors.length > 0) process.exitCode = 1;
} finally {
    await browser.close();
    server.closeIdleConnections();
    server.closeAllConnections();
    await new Promise(resolveClosed => server.close(resolveClosed));
}
