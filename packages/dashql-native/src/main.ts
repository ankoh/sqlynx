import {access, mkdir, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import {watch} from "node:fs";
import {createServer} from "node:http";
import path from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {brotliDecompress} from "node:zlib";

import {app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell, utilityProcess, type WebContents} from "electron";

import {APP_ORIGIN, APP_RESPONSE_HEADERS, contentHeadersFor, isBrotliWasm, isTrustedRendererUrl, parseRendererDevOrigin, resolveAppRequest} from "./app_protocol.js";
import {DeepLinkQueue, parseDeepLink, parseDeepLinksFromCommandLine} from "./deep_link.js";
import {DirectoryWatchRegistry} from "./directory_watch_registry.js";
import {GrpcTestServer, GRPC_TEST_REQUEST, GRPC_TEST_STREAM_BODY, GRPC_TEST_UNARY_RESPONSE} from "./grpc_test_server.js";
import {NativeProxyService, type NativeProxyRequest, validateNativeProxyRequest} from "./native_proxy.js";
import {createElectronUpdater, type ElectronUpdater} from "./updater.js";

protocol.registerSchemesAsPrivileged([
    {
        scheme: "app",
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
        },
    },
]);

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = process.env.DASHQL_ELECTRON_RENDERER ?? path.join(process.resourcesPath, "renderer");
const rendererDevOrigin = parseRendererDevOrigin(process.env.DASHQL_ELECTRON_RENDERER_URL);
const decompressBrotli = promisify(brotliDecompress);
const deepLinks = new DeepLinkQueue();
let deepLinkSender: WebContents | null = null;
let nativeProxy: NativeProxyService | null = null;
let mainWindow: BrowserWindow | null = null;
let updater: ElectronUpdater | null = null;
const directoryWatches = new DirectoryWatchRegistry();

if (process.argv.some((arg) => arg.endsWith("-test") || arg.includes("-test="))) {
    app.disableHardwareAcceleration();
}

function startNativeProxy(): NativeProxyService {
    const workerPath = process.env.DASHQL_NATIVE_UTILITY_WORKER ?? path.join(moduleDirectory, "native_utility_worker.js");
    const addonPath = process.env.DASHQL_NATIVE_ADDON ?? path.join(process.resourcesPath, "dashql_native_napi.node");
    const child = utilityProcess.fork(workerPath, [], {
        env: {...process.env, DASHQL_NATIVE_ADDON: addonPath},
        serviceName: "DashQL Native Proxy",
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    return new NativeProxyService(child);
}

async function handleAppRequest(request: Request): Promise<Response> {
    const filePath = resolveAppRequest(rendererRoot, request.url);
    if (filePath === null) {
        return new Response("Not found", {status: 404, headers: APP_RESPONSE_HEADERS});
    }

    try {
        const encodedBody = await readFile(filePath);
        const body = isBrotliWasm(filePath) ? await decompressBrotli(encodedBody) : encodedBody;
        return new Response(body, {
            headers: {
                ...APP_RESPONSE_HEADERS,
                ...contentHeadersFor(filePath),
            },
        });
    } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
        const status = code === "ENOENT" || code === "EISDIR" ? 404 : 500;
        return new Response(status === 404 ? "Not found" : "Internal error", {
            status,
            headers: APP_RESPONSE_HEADERS,
        });
    }
}

type RendererTestMode = "capability" | "startup" | null;

function rendererTestMode(): RendererTestMode {
    if (process.argv.includes("--capability-test")) return "capability";
    if (process.argv.includes("--startup-smoke-test")) return "startup";
    return null;
}

async function createWindow(testMode: RendererTestMode): Promise<BrowserWindow> {
    const preload = process.env.DASHQL_ELECTRON_PRELOAD ?? path.resolve(moduleDirectory, "../preload.cjs");
    const window = new BrowserWindow({
        width: 1500,
        height: 900,
        titleBarStyle: "hiddenInset",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload,
            sandbox: true,
            webSecurity: true,
        },
    });
    window.webContents.setWindowOpenHandler(() => ({action: "deny"}));
    if (rendererDevOrigin !== null) {
        window.webContents.on("context-menu", (_event, params) => {
            Menu.buildFromTemplate([
                {
                    label: "Reload",
                    click: () => window.webContents.reload(),
                },
                {
                    label: "Inspect Element",
                    click: () => window.webContents.inspectElement(params.x, params.y),
                },
            ]).popup({window});
        });
    }
    if (testMode !== null) {
        window.webContents.on("console-message", (_event, level, message) => {
            console.error(`[renderer:${level}] ${message}`);
        });
        window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
            console.error(`Renderer load failed: ${errorCode} ${errorDescription} ${validatedURL}`);
        });
        window.webContents.on("render-process-gone", (_event, details) => {
            console.error(`Renderer process exited: ${details.reason} (${details.exitCode})`);
        });
    }
    window.webContents.on("will-navigate", (event, target) => {
        if (!isTrustedRendererUrl(target, rendererDevOrigin)) {
            event.preventDefault();
        }
    });
    const target = testMode === "capability"
        ? `hyperdb-capability.html?mode=${testMode}`
        : "index.html";
    await window.loadURL(`${rendererDevOrigin ?? APP_ORIGIN}/${target}`);
    window.on("closed", () => {
        if (mainWindow === window) mainWindow = null;
        deepLinks.detach();
    });
    mainWindow = window;
    return window;
}

async function runCapabilityTest(window: BrowserWindow): Promise<void> {
    const capabilities = await window.webContents.executeJavaScript(`(async () => {
        const memory64Probe = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x05, 0x03, 0x01, 0x04, 0x01,
        ]);
        const sharedMemory = new WebAssembly.Memory({initial: 1, maximum: 1, shared: true});
        const workerSource = \`onmessage = ({data}) => postMessage(
            data instanceof WebAssembly.Memory && data.buffer instanceof SharedArrayBuffer
        )\`;
        const workerUrl = URL.createObjectURL(new Blob([workerSource], {type: "text/javascript"}));
        const sharedMemoryWorker = await new Promise((resolve, reject) => {
            const worker = new Worker(workerUrl);
            worker.onmessage = ({data}) => {
                worker.terminate();
                URL.revokeObjectURL(workerUrl);
                resolve(data === true);
            };
            worker.onerror = (error) => {
                worker.terminate();
                URL.revokeObjectURL(workerUrl);
                reject(error);
            };
            worker.postMessage(sharedMemory);
        });
        return {
            crossOriginIsolated: globalThis.crossOriginIsolated,
            memory64: WebAssembly.validate(memory64Probe),
            secureContext: globalThis.isSecureContext,
            sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === "function",
            sharedMemoryWorker,
        };
    })()`) as {
        crossOriginIsolated: boolean;
        memory64: boolean;
        secureContext: boolean;
        sharedArrayBuffer: boolean;
        sharedMemoryWorker: boolean;
    };
    const result = {
        ...capabilities,
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        node: process.versions.node,
    };
    const hyperdb = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 120000;
        const poll = () => {
            if (globalThis.__DASHQL_HYPERDB_CAPABILITY__ !== undefined) {
                resolve(globalThis.__DASHQL_HYPERDB_CAPABILITY__);
            } else if (Date.now() >= deadline) {
                reject(new Error("Timed out waiting for HyperDB capability result"));
            } else {
                setTimeout(poll, 100);
            }
        };
        poll();
    })`) as {
        answer?: number;
        engine?: string;
        error?: string;
        initialized: boolean;
        version?: string;
    };
    Object.assign(result, {hyperdb});
    console.log(JSON.stringify(result));
    const passed = result.crossOriginIsolated && result.memory64 && result.secureContext &&
        result.sharedArrayBuffer && result.sharedMemoryWorker && hyperdb.initialized &&
        hyperdb.answer === 42 && hyperdb.engine === "hyper" && hyperdb.version?.includes("hyper version");
    app.exit(passed ? 0 : 1);
}

async function waitForRendererResult<T>(window: BrowserWindow, expression: string): Promise<T> {
    return await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 120000;
        const poll = () => {
            const result = ${expression};
            if (result !== undefined) resolve(result);
            else if (Date.now() >= deadline) reject(new Error("Timed out waiting for renderer result"));
            else setTimeout(poll, 100);
        };
        poll();
    })`) as T;
}

async function runStartupSmokeTest(window: BrowserWindow): Promise<void> {
    const result = await waitForRendererResult<{
        embeddedDatabase: string | null;
        error?: string;
        host: string;
        status: string;
    }>(window, "globalThis.__DASHQL_STARTUP__");
    const runtime = await window.webContents.executeJavaScript(`({
        crossOriginIsolated: globalThis.crossOriginIsolated,
        electronBridge: typeof globalThis.dashqlElectron === "object",
        legacyBridge: "__TAURI_INTERNALS__" in globalThis,
    })`) as {crossOriginIsolated: boolean; electronBridge: boolean; legacyBridge: boolean};
    const output = {...result, ...runtime};
    console.log(JSON.stringify(output));
    const passed = result.status === "ready" && result.host === "electron" &&
        result.embeddedDatabase === "hyperdb-wasm" && runtime.crossOriginIsolated &&
        runtime.electronBridge && !runtime.legacyBridge;
    app.exit(passed ? 0 : 1);
}

async function runNativeAddonTest(): Promise<void> {
    const received = {body: Buffer.alloc(0), method: "", url: ""};
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            received.body = Buffer.concat(chunks);
            received.method = request.method ?? "";
            received.url = request.url ?? "";
            response.writeHead(206, {
                "content-type": "application/octet-stream",
                "dashql-test-header": "loopback",
            });
            response.write(Buffer.from([1, 2, 3, 4]));
            response.end(Buffer.from([5, 6, 7, 8]));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Loopback server did not bind a TCP port");
    const grpcServer = new GrpcTestServer();
    await grpcServer.start();
    if (grpcServer.endpoint === null) throw new Error("gRPC loopback server did not start");

    const proxy = startNativeProxy();
    try {
        const health = await proxy.request({body: new Uint8Array(), headers: [], method: "GET", url: "dashql-native://localhost/health"});
        const requestBody = new Uint8Array([0, 1, 2, 127, 128, 255]);
        const started = await proxy.request({
            body: requestBody,
            headers: [
                ["dashql-method", "POST"],
                ["dashql-endpoint", `http://127.0.0.1:${address.port}`],
                ["dashql-path", "/stream-test"],
                ["dashql-search-params", "token=loopback"],
                ["dashql-read-timeout", "10000"],
                ["content-type", "application/octet-stream"],
                ["x-dashql-forwarded-test", "native-utility"],
            ],
            method: "POST",
            url: "dashql-native://localhost/http/streams",
        });
        const streamId = started.headers.find(([name]) => name === "dashql-stream-id")?.[1];
        if (streamId === undefined) throw new Error("HTTP proxy did not return a stream ID");
        const streamed = await proxy.request({
            body: new Uint8Array(),
            headers: [
                ["dashql-read-timeout", "10000"],
                ["dashql-batch-timeout", "10000"],
                ["dashql-batch-bytes", "10000"],
            ],
            method: "GET",
            url: `dashql-native://localhost/http/stream/${streamId}`,
        });
        const removed = await proxy.request({
            body: new Uint8Array(),
            headers: [],
            method: "DELETE",
            url: `dashql-native://localhost/http/stream/${streamId}`,
        });
        const headers = new Map(streamed.headers.map((header) => [header[0], header[1]] as const));
        const grpcChannel = await proxy.request({
            body: new Uint8Array(),
            headers: [["dashql-endpoint", grpcServer.endpoint]],
            method: "POST",
            url: "dashql-native://localhost/grpc/channels",
        });
        const grpcChannelId = grpcChannel.headers.find(([name]) => name === "dashql-channel-id")?.[1];
        if (grpcChannelId === undefined) throw new Error("gRPC proxy did not return a channel ID");
        const grpcUnary = await proxy.request({
            body: GRPC_TEST_REQUEST,
            headers: [
                ["dashql-path", "/dashql.test.TestService/TestUnary"],
                ["x-test-request", "unary"],
            ],
            method: "POST",
            url: `dashql-native://localhost/grpc/channel/${grpcChannelId}/unary`,
        });
        const grpcUnaryHeaders = new Map(grpcUnary.headers.map((header) => [header[0], header[1]] as const));
        const grpcStreamStarted = await proxy.request({
            body: GRPC_TEST_REQUEST,
            headers: [
                ["dashql-path", "/dashql.test.TestService/TestServerStreaming"],
                ["x-test-request", "stream"],
            ],
            method: "POST",
            url: `dashql-native://localhost/grpc/channel/${grpcChannelId}/streams`,
        });
        const grpcStreamId = grpcStreamStarted.headers.find(([name]) => name === "dashql-stream-id")?.[1];
        if (grpcStreamId === undefined) throw new Error("gRPC proxy did not return a stream ID");
        const grpcStream = await proxy.request({
            body: new Uint8Array(),
            headers: [
                ["dashql-read-timeout", "10000"],
                ["dashql-batch-timeout", "10000"],
                ["dashql-batch-bytes", "10000"],
            ],
            method: "GET",
            url: `dashql-native://localhost/grpc/channel/${grpcChannelId}/stream/${grpcStreamId}`,
        });
        const grpcStreamHeaders = new Map(grpcStream.headers.map((header) => [header[0], header[1]] as const));
        const grpcStreamRemoved = await proxy.request({
            body: new Uint8Array(),
            headers: [],
            method: "DELETE",
            url: `dashql-native://localhost/grpc/channel/${grpcChannelId}/stream/${grpcStreamId}`,
        });
        const grpcChannelRemoved = await proxy.request({
            body: new Uint8Array(),
            headers: [],
            method: "DELETE",
            url: `dashql-native://localhost/grpc/channel/${grpcChannelId}`,
        });
        grpcServer.assertHealthy();
        const output = {
            grpcChannelRemovedStatus: grpcChannelRemoved.status,
            grpcRequestCount: grpcServer.requests.length,
            grpcStreamBody: [...grpcStream.body],
            grpcStreamEvent: grpcStreamHeaders.get("dashql-batch-event"),
            grpcStreamMessages: grpcStreamHeaders.get("dashql-batch-messages"),
            grpcStreamRemovedStatus: grpcStreamRemoved.status,
            grpcStreamTrailer: grpcStreamHeaders.get("x-test-trailer"),
            grpcUnaryBody: [...grpcUnary.body],
            grpcUnaryInitial: grpcUnaryHeaders.get("x-test-initial"),
            health: new TextDecoder().decode(health.body),
            receivedBody: [...received.body],
            receivedMethod: received.method,
            receivedUrl: received.url,
            removedStatus: removed.status,
            streamBody: [...streamed.body],
            streamEvent: headers.get("dashql-batch-event"),
            streamStatus: streamed.status,
        };
        console.log(JSON.stringify(output));
        const passed = output.health === '{"status":"ok"}' && output.receivedMethod === "POST" &&
            output.receivedUrl === "/stream-test?token=loopback" &&
            Buffer.compare(received.body, requestBody) === 0 && streamed.status === 206 &&
            Buffer.compare(Buffer.from(streamed.body), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])) === 0 &&
            headers.get("dashql-test-header") === "loopback" &&
            headers.get("dashql-batch-event") === "StreamFinished" && removed.status === 200 &&
            grpcServer.requests.length === 2 &&
            grpcServer.requests[0]?.headers["x-test-request"] === "unary" &&
            grpcServer.requests[1]?.headers["x-test-request"] === "stream" &&
            grpcUnary.status === 200 && Buffer.compare(Buffer.from(grpcUnary.body), GRPC_TEST_UNARY_RESPONSE) === 0 &&
            grpcUnaryHeaders.get("x-test-initial") === "unary" && grpcStream.status === 200 &&
            Buffer.compare(Buffer.from(grpcStream.body), GRPC_TEST_STREAM_BODY) === 0 &&
            grpcStreamHeaders.get("dashql-batch-event") === "StreamFinished" &&
            grpcStreamHeaders.get("dashql-batch-messages") === "2" &&
            grpcStreamHeaders.get("dashql-batch-bytes") === "6" &&
            grpcStreamHeaders.get("x-test-trailer") === "stream-done" &&
            grpcStreamRemoved.status === 200 && grpcChannelRemoved.status === 200;
        await grpcServer.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        app.exit(passed ? 0 : 1);
    } finally {
        proxy.close();
        server.closeAllConnections();
        if (server.listening) server.close();
        if (grpcServer.endpoint !== null) await grpcServer.close();
    }
}

function isTrustedRenderer(url: string | undefined): boolean {
    return isTrustedRendererUrl(url, rendererDevOrigin);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
} else {
    if (process.defaultApp && process.argv[1] !== undefined) {
        app.setAsDefaultProtocolClient("dashql", process.execPath, [path.resolve(process.argv[1])]);
    } else {
        app.setAsDefaultProtocolClient("dashql");
    }
    for (const data of parseDeepLinksFromCommandLine(process.argv)) deepLinks.push(data);

    app.on("open-url", (event, link) => {
        event.preventDefault();
        const data = parseDeepLink(link);
        if (data !== null) deepLinks.push(data);
    });

    app.on("second-instance", (_event, commandLine) => {
        for (const data of parseDeepLinksFromCommandLine(commandLine)) deepLinks.push(data);
        if (mainWindow !== null) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    ipcMain.handle("dashql:get-initial-deep-links", (event) => {
        if (!isTrustedRenderer(event.senderFrame?.url)) {
            throw new Error("Rejected deep-link request from an untrusted frame");
        }
        const sender = event.sender;
        const initial = deepLinks.attach((link) => {
            if (!sender.isDestroyed()) sender.send("dashql:deep-link", link);
        });
        if (deepLinkSender !== sender) {
            deepLinkSender = sender;
            sender.once("destroyed", () => {
                if (deepLinkSender === sender) {
                    deepLinkSender = null;
                    deepLinks.detach();
                }
            });
        }
        return initial;
    });

    ipcMain.handle("dashql:open-directory", async (event, title: unknown) => {
        if (!isTrustedRenderer(event.senderFrame?.url) || typeof title !== "string") throw new Error("Rejected directory request");
        const result = await dialog.showOpenDialog({properties: ["openDirectory", "createDirectory"], title});
        return result.canceled ? null : result.filePaths[0] ?? null;
    });

    ipcMain.handle("dashql:confirm", async (event, options: unknown) => {
        if (!isTrustedRenderer(event.senderFrame?.url) || options === null || typeof options !== "object") throw new Error("Rejected confirmation request");
        const {message, title} = options as {message?: unknown; title?: unknown};
        if (typeof message !== "string" || typeof title !== "string") throw new Error("Rejected confirmation request");
        const result = await dialog.showMessageBox({buttons: ["Keep current", "Reload"], cancelId: 0, defaultId: 1, message, title, type: "warning"});
        return result.response === 1;
    });

    ipcMain.handle("dashql:fs", async (event, operation: unknown, ...args: unknown[]) => {
        if (!isTrustedRenderer(event.senderFrame?.url) || typeof operation !== "string") throw new Error("Rejected filesystem request");
        const requirePath = (value: unknown): string => {
            if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("Rejected filesystem path");
            return value;
        };
        const target = requirePath(args[0]);
        switch (operation) {
            case "exists": try { await access(target); return true; } catch { return false; }
            case "mkdir": return await mkdir(target, {recursive: (args[1] as {recursive?: boolean} | undefined)?.recursive ?? false});
            case "readDir": return (await readdir(target, {withFileTypes: true})).map(entry => ({name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink()}));
            case "readFile": return new Uint8Array(await readFile(target));
            case "readTextFile": return await readFile(target, "utf8");
            case "remove": return await rm(target, {recursive: (args[1] as {recursive?: boolean} | undefined)?.recursive ?? false, force: false});
            case "rename": return await rename(target, requirePath(args[1]));
            case "stat": { const value = await stat(target); return {size: value.size, mtime: value.mtime.toISOString(), isFile: value.isFile(), isDirectory: value.isDirectory(), isSymlink: value.isSymbolicLink()}; }
            case "writeFile": return await writeFile(target, typeof args[1] === "string" ? args[1] : Buffer.from(args[1] as Uint8Array));
            case "writeTextFile": if (typeof args[1] === "string") return await writeFile(target, args[1], "utf8"); break;
        }
        throw new Error("Rejected filesystem operation");
    });

    ipcMain.handle("dashql:watch-directory", (event, requestedPath: unknown) => {
        if (!isTrustedRenderer(event.senderFrame?.url) || typeof requestedPath !== "string" || !path.isAbsolute(requestedPath)) throw new Error("Rejected watch request");
        const sender = event.sender;
        const watcher = watch(requestedPath, {recursive: true}, (_event, filename) => {
            if (!sender.isDestroyed()) sender.send(`dashql:watch-directory:${watchId}`, [filename === null ? requestedPath : path.join(requestedPath, filename)]);
        });
        const watchId = directoryWatches.add(sender, watcher);
        return watchId;
    });
    ipcMain.handle("dashql:unwatch-directory", (event, watchId: unknown) => {
        if (!isTrustedRenderer(event.senderFrame?.url) || typeof watchId !== "number") throw new Error("Rejected unwatch request");
        directoryWatches.close(watchId);
    });

    ipcMain.handle("dashql:runtime-capabilities", (event) => {
        if (!isTrustedRenderer(event.senderFrame?.url)) {
            throw new Error("Rejected runtime capability request from an untrusted frame");
        }
        return {
            chrome: process.versions.chrome,
            electron: process.versions.electron,
            node: process.versions.node,
        };
    });

    ipcMain.handle("dashql:open-external", async (event, requestedUrl: unknown) => {
        if (!isTrustedRenderer(event.senderFrame?.url) || typeof requestedUrl !== "string") {
            throw new Error("Rejected external URL request");
        }
        const url = new URL(requestedUrl);
        if (url.protocol !== "https:") throw new Error("Rejected external URL request");
        await shell.openExternal(url.toString());
    });

    ipcMain.handle("dashql:update-status", (event) => {
        if (!isTrustedRenderer(event.senderFrame?.url)) throw new Error("Rejected update request from an untrusted frame");
        return updater?.getStatus() ?? {status: "disabled"};
    });
    ipcMain.handle("dashql:check-for-updates", async (event, channel?: "canary" | "stable") => {
        if (!isTrustedRenderer(event.senderFrame?.url)) throw new Error("Rejected update request from an untrusted frame");
        if (channel !== undefined && channel !== "canary" && channel !== "stable") throw new Error("Rejected invalid update channel");
        return await updater?.check(channel) ?? {status: "disabled"};
    });
    ipcMain.handle("dashql:download-update", async (event, channel: unknown) => {
        if (!isTrustedRenderer(event.senderFrame?.url)) throw new Error("Rejected update request from an untrusted frame");
        if (channel !== "canary" && channel !== "stable") throw new Error("Rejected invalid update channel");
        if (updater === null) throw new Error("Updates are unavailable");
        await updater.download(channel);
    });
    ipcMain.handle("dashql:install-update", (event) => {
        if (!isTrustedRenderer(event.senderFrame?.url)) throw new Error("Rejected update request from an untrusted frame");
        if (updater === null) throw new Error("Updates are unavailable");
        updater.install();
    });

    ipcMain.handle("dashql:native-proxy-request", async (event, request: NativeProxyRequest) => {
        if (!isTrustedRenderer(event.senderFrame?.url)) {
            throw new Error("Rejected native proxy request from an untrusted frame");
        }
        validateNativeProxyRequest(request);
        if (new URL(request.url).pathname === "/health") {
            throw new Error("Rejected internal native proxy route");
        }
        if (nativeProxy === null) throw new Error("Native proxy is unavailable");
        return await nativeProxy.request(request);
    });

    app.whenReady().then(async () => {
        protocol.handle("app", handleAppRequest);
        if (process.argv.includes("--native-addon-test")) {
            await runNativeAddonTest();
            return;
        }
        const testMode = rendererTestMode();
        if (app.isPackaged || process.env.DASHQL_ENABLE_DEV_UPDATES) {
            updater = createElectronUpdater(app.getVersion(), () => mainWindow);
        }
        nativeProxy = startNativeProxy();
        await nativeProxy.ready();
        const window = await createWindow(testMode);
        if (testMode === null) void updater?.check().catch((error) => console.error("Update check failed", error));
        if (testMode === "capability") {
            await runCapabilityTest(window);
        } else if (testMode === "startup") {
            await runStartupSmokeTest(window);
        }
    }).catch((error) => {
        console.error(error);
        app.exit(1);
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") {
            app.quit();
        }
    });

    app.on("before-quit", () => {
        nativeProxy?.close();
        nativeProxy = null;
    });

    app.on("activate", async () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            await createWindow(null);
        }
    });
}
