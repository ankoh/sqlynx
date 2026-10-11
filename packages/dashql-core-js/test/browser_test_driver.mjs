import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import * as playwright from 'playwright-core';

const root = resolve(process.argv[2]);
const browserName = process.env.DASHQL_BROWSER ?? 'chromium';
const executableRoot = process.env.DASHQL_BROWSER_EXECUTABLE_ROOT;
const executablePath = executableRoot
    ? join(executableRoot, process.platform === 'darwin' ? 'firefox/Nightly.app/Contents/MacOS/firefox' : 'firefox/firefox')
    : process.env.DASHQL_BROWSER_EXECUTABLE;
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file = resolve(root, decodeURIComponent(pathname).replace(/^\//, ''));
    if (!file.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
    }
    try {
        if (!statSync(file).isFile()) throw new Error('Not a file');
        response.writeHead(200, {
            'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
        });
        createReadStream(file).pipe(response);
    } catch {
        response.writeHead(404).end('Not found');
    }
});
await new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListening);
});
let browser;
let page;
const errors = [];
try {
    browser = await playwright[browserName].launch({ executablePath: realpathSync(executablePath), headless: true });
    page = await browser.newPage();
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.stack ?? error.message));
    const query = new URLSearchParams();
    if (process.argv[3]) query.set('file', process.argv[3]);
    await page.goto(`http://127.0.0.1:${server.address().port}/tests.html?${query}`, { waitUntil: 'domcontentloaded' });
    // Accept terminal states immediately: small filtered suites can finish before the first poll.
    await page.waitForFunction(() => ['passed', 'failed'].includes(globalThis.__DASHQL_BROWSER_TESTS__?.status), null, {
        timeout: Number.parseInt(process.env.DASHQL_BROWSER_TEST_TIMEOUT ?? '600000', 10),
    });
    const summary = await page.evaluate(() => globalThis.__DASHQL_BROWSER_TESTS__);
    console.log(`${summary.files.length} files, ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped in ${(summary.duration / 1000).toFixed(2)}s`);
    for (const file of summary.files) {
        if (file.error) console.error(`${file.file}\n${file.error.stack ?? file.error.message}`);
        for (const test of file.tests.filter(test => test.status === 'failed')) {
            console.error(`${file.file}: ${test.titlePath.join(' > ')}\n${test.error?.stack ?? test.error?.message ?? 'Failed'}`);
        }
    }
    if (summary.status !== 'passed' || errors.length > 0) process.exitCode = 1;
} catch (error) {
    console.error(error);
    if (page) console.error(await page.evaluate(() => globalThis.__DASHQL_BROWSER_TESTS__));
    process.exitCode = 1;
} finally {
    if (errors.length > 0) console.error(errors.join('\n'));
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolveClosed => server.close(resolveClosed));
}
