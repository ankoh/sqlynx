const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("dashqlElectron", {
    confirm: async (options) => await ipcRenderer.invoke("dashql:confirm", options),
    fs: {
        exists: async (path) => await ipcRenderer.invoke("dashql:fs", "exists", path),
        mkdir: async (path, options) => await ipcRenderer.invoke("dashql:fs", "mkdir", path, options),
        readDir: async (path) => await ipcRenderer.invoke("dashql:fs", "readDir", path),
        readFile: async (path) => new Uint8Array(await ipcRenderer.invoke("dashql:fs", "readFile", path)),
        readTextFile: async (path) => await ipcRenderer.invoke("dashql:fs", "readTextFile", path),
        remove: async (path, options) => await ipcRenderer.invoke("dashql:fs", "remove", path, options),
        rename: async (from, to) => await ipcRenderer.invoke("dashql:fs", "rename", from, to),
        stat: async (path) => await ipcRenderer.invoke("dashql:fs", "stat", path),
        writeFile: async (path, data) => await ipcRenderer.invoke("dashql:fs", "writeFile", path, new Uint8Array(data)),
        writeTextFile: async (path, data) => await ipcRenderer.invoke("dashql:fs", "writeTextFile", path, data),
    },
    getInitialDeepLinks: async () => await ipcRenderer.invoke("dashql:get-initial-deep-links"),
    getRuntimeCapabilities: async () => {
        const versions = await ipcRenderer.invoke("dashql:runtime-capabilities");
        return {
            ...versions,
            crossOriginIsolated: globalThis.crossOriginIsolated,
            secureContext: globalThis.isSecureContext,
            sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === "function",
        };
    },
    nativeProxyRequest: async (request) => await ipcRenderer.invoke("dashql:native-proxy-request", {
        body: new Uint8Array(request.body),
        headers: request.headers.map((header) => [header[0], header[1]]),
        method: request.method,
        url: request.url,
    }),
    openExternal: async (url) => await ipcRenderer.invoke("dashql:open-external", url),
    oauthLoopback: {
        listen: async (callbackUrl) => await ipcRenderer.invoke("dashql:oauth-loopback-listen", callbackUrl),
        wait: async (loopbackId) => await ipcRenderer.invoke("dashql:oauth-loopback-wait", loopbackId),
        close: async (loopbackId) => await ipcRenderer.invoke("dashql:oauth-loopback-close", loopbackId),
    },
    updates: {
        check: async (channel) => await ipcRenderer.invoke("dashql:check-for-updates", channel),
        download: async (channel) => await ipcRenderer.invoke("dashql:download-update", channel),
        getStatus: async () => await ipcRenderer.invoke("dashql:update-status"),
        install: async () => await ipcRenderer.invoke("dashql:install-update"),
        onStatus: (listener) => {
            const handler = (_event, status) => listener(status);
            ipcRenderer.on("dashql:update-status", handler);
            return () => ipcRenderer.removeListener("dashql:update-status", handler);
        },
    },
    onDeepLink: (listener) => {
        const handler = (_event, data) => listener(data);
        ipcRenderer.on("dashql:deep-link", handler);
        return () => ipcRenderer.removeListener("dashql:deep-link", handler);
    },
    openDirectory: async (title) => await ipcRenderer.invoke("dashql:open-directory", title),
    watchDirectory: async (path, listener) => {
        const watchId = await ipcRenderer.invoke("dashql:watch-directory", path);
        const channel = `dashql:watch-directory:${watchId}`;
        const handler = (_event, paths) => listener(paths);
        ipcRenderer.on(channel, handler);
        return async () => {
            ipcRenderer.removeListener(channel, handler);
            await ipcRenderer.invoke("dashql:unwatch-directory", watchId);
        };
    },
});
