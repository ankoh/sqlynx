import react from "@vitejs/plugin-react";
import { checker } from "vite-plugin-checker";
import * as vite from "vite";
import * as path from "node:path";
import * as nodeFs from "node:fs";

const DASHQL_VERSION = "__DASHQL_VERSION__";
const DASHQL_COMMIT = "__DASHQL_COMMIT__";
const HYPERDB_WASM_VERSION = "__HYPERDB_WASM_VERSION__";

export default vite.defineConfig(({ mode, command }) => {
    const isElectronBuild = mode === 'electron';
    const isReloc = mode === 'reloc' || isElectronBuild;
    const includesBrowserTests = mode === 'pages' || mode === 'development';
    const base = isReloc ? './' : '/';
    const rootDir = process.cwd();
    const PUBLIC_DIR = path.resolve(rootDir, "__PUBLIC_DIR__");
    const CORE_PATH = path.resolve(rootDir, "__CORE_PATH__");
    const PROTOBUF_PATH = path.resolve(rootDir, "__PROTOBUF_PATH__");
    const JSONSCHEMA_PATH = path.resolve(rootDir, "__JSONSCHEMA_PATH__");
    const SHELL_JS_PATH = path.resolve(rootDir, "__SHELL_JS_PATH__");
    const SHELL_WASM_PATH = path.resolve(rootDir, "__SHELL_WASM_PATH__");
    // Entry point of the vendored UMAP wasm module (dependencies/umap-wasm/index.js).
    // Its glue (pkg/umap_wasm.js) loads pkg/umap_wasm_bg.wasm relatively via
    // import.meta.url, so only the entry needs an alias — the .wasm has no placeholder.
    const UMAP_JS_PATH = path.resolve(rootDir, "__UMAP_JS_PATH__");
    const SVG_SYMBOLS_PATH = path.resolve(rootDir, "__SVG_SYMBOLS_PATH__");

    return {
        plugins: [
            react(),
            // In the Bazel sandbox, HTML entry files are symlinks to the execroot. Rolldown
            // follows them during input resolution, causing vite:build-html to compute the
            // output fileName as a deep ../../execroot/... traversal, which Rolldown rejects.
            // Intercept absolute HTML resolution and return the id unchanged to preserve the
            // sandbox symlink path.
            {
                name: 'bazel-preserve-html-entry-symlinks',
                enforce: 'pre' as const,
                resolveId(id: string): string | undefined {
                    if (id.endsWith('.html') && path.isAbsolute(id)) {
                        return id;
                    }
                },
            },
            ...(includesBrowserTests ? [{
                name: 'dashql-browser-test-file',
                enforce: 'pre' as const,
                transform(code: string, id: string): string | undefined {
                    const cleanId = id.split('?', 1)[0]?.split(path.sep).join('/');
                    if (!cleanId || !/\.test\.(ts|tsx)$/.test(cleanId)) return;
                    const sourceIndex = cleanId.lastIndexOf('/src/');
                    if (sourceIndex < 0) return;
                    const file = cleanId.slice(sourceIndex + 1);
                    return `globalThis.__DASHQL_SET_CURRENT_TEST_FILE__(${JSON.stringify(file)});\n${code}`;
                },
            }] : []),
            checker({
                enableBuild: false,
                typescript: true,
            }),
        ],
        root: rootDir,
        publicDir: PUBLIC_DIR,
        base,
        build: {
            target: 'es2020',
            rolldownOptions: {
                input: {
                    app: path.resolve(rootDir, "index.html"),
                    shell: path.resolve(rootDir, "shell.html"),
                    oauth_redirect: path.resolve(rootDir, "oauth.html"),
                    ...(isElectronBuild
                        ? { hyperdb_capability: path.resolve(rootDir, "hyperdb-capability.html") }
                        : {}),
                    ...(includesBrowserTests ? {
                        tests: path.resolve(rootDir, "tests.html"),
                        tests_frame: path.resolve(rootDir, "tests-frame.html"),
                    } : {}),
                },
                external: (id) => {
                    if (typeof id !== 'string') return false;
                    if (id.startsWith('node:')) return true;
                    const builtins = new Set(['stream', 'buffer', 'fs', 'path', 'util', 'os', 'crypto', 'url', 'assert', 'events', 'module', 'process']);
                    return builtins.has(id);
                },
                output: {
                    entryFileNames: 'static/js/[name].[hash].js',
                    chunkFileNames: 'static/js/[name].[hash].js',
                    assetFileNames: (assetInfo) => {
                        const name = (assetInfo?.names.length > 0 ? assetInfo.names[0] : '');
                        const ext = (assetInfo as { extname?: string }).extname ?? '';
                        if (/\.(css)$/.test(name) || ext === '.css') return 'static/css/[name].[hash][extname]';
                        if (/\.(wasm|wasm\.map)$/.test(name) || ext === '.wasm') return 'static/wasm/[name].[hash][extname]';
                        if (/\.(js|mjs)$/i.test(name) || ext === '.js' || ext === '.mjs') return 'static/js/[name].[hash][extname]';
                        if (/\.(sql)$/i.test(name) || /\.sql$/i.test(ext)) return 'static/scripts/[name].[hash][extname]';
                        if (/\.(png|jpe?g|gif|ico|svg)$/i.test(name)) return 'static/img/[name].[hash][extname]';
                        if (/\.(ttf)$/i.test(name) || ext === '.ttf') return 'static/fonts/[name].[hash][extname]';
                        return 'static/assets/[name].[hash][extname]';
                    },
                },
            },
            minify: mode !== 'development' ? 'oxc' : false,
            cssCodeSplit: true,
            modulePreload: { polyfill: false },
        },
        define: {
            'process.env.DASHQL_BUILD_MODE': JSON.stringify(command === 'serve' ? 'development' : 'production'),
            'process.env.DASHQL_VERSION': JSON.stringify(DASHQL_VERSION),
            'process.env.DASHQL_GIT_COMMIT': JSON.stringify(DASHQL_COMMIT),
            'process.env.HYPERDB_WASM_VERSION': JSON.stringify(HYPERDB_WASM_VERSION),
            'process.env.DASHQL_APP_URL': JSON.stringify(process.env.DASHQL_APP_URL || 'https://dashql.app'),
            'process.env.DASHQL_RELATIVE_IMPORTS': JSON.stringify(isReloc),
        },
        resolve: {
            alias: [
                { find: /^@ankoh\/dashql-core$/, replacement: path.join(CORE_PATH, 'index.js') },
                { find: /^@ankoh\/dashql-core\/buffers$/, replacement: path.join(CORE_PATH, 'buffers.js') },
                { find: /^@ankoh\/dashql-core\/browser-worker$/, replacement: path.join(CORE_PATH, 'browser_worker.js') },
                { find: /@ankoh\/dashql-protobuf/, replacement: PROTOBUF_PATH },
                { find: /@ankoh\/dashql-jsonschema/, replacement: JSONSCHEMA_PATH },
                {
                    find: /^@ankoh\/dashql-core\/wasm(\?.*)?$/,
                    replacement: path.join(CORE_PATH, 'wasm/dashql_core.wasm') + "$1",
                },
                {
                    find: /^@ankoh\/dashql-shell-js(\?.*)?$/,
                    replacement: SHELL_JS_PATH + "$1",
                },
                {
                    find: /^@ankoh\/dashql-shell-wasm(\?.*)?$/,
                    replacement: SHELL_WASM_PATH + "$1",
                },
                {
                    find: /^@dashql\/hyperdb-wasm-worker\?url$/,
                    replacement: path.resolve(rootDir, '../../node_modules/hyperdb-wasm/dist/browser_worker.js') + '?url',
                }, {
                    find: /^@dashql\/hyperdb-wasm-js\?url$/,
                    replacement: path.resolve(rootDir, '../../node_modules/hyperdb-wasm/dist/hyperdb-wasm.js') + '?url',
                }, {
                    find: /^@dashql\/hyperdb-wasm\?url$/,
                    replacement: path.resolve(rootDir, '../../node_modules/hyperdb-wasm/dist/hyperdb-wasm.wasm.br') + '?url',
                },
                {
                    find: /^@dashql\/umap-wasm(\?.*)?$/,
                    replacement: UMAP_JS_PATH + "$1",
                },
                { find: /@ankoh\/dashql-svg-symbols/, replacement: SVG_SYMBOLS_PATH },
                {
                    find: /^@dashql\/browser-test-act$/,
                    replacement: path.resolve(rootDir, "src/tests/react_act.ts"),
                },
                ...(includesBrowserTests ? [{
                    find: /^vitest$/,
                    replacement: path.resolve(rootDir, "src/tests/vitest_compat.ts"),
                }] : []),
            ],
        },
        css: {
            modules: {
                localsConvention: 'camelCase',
                generateScopedName: command === 'serve' ? '[local]_[hash:base64:5]' : '[hash:base64]',
            },
        },
        server: {
            port: 9002,
            strictPort: true,
            hmr: true,
            cors: true,
            // Enable Cross-Origin Isolation for SharedArrayBuffer (required for multi-threaded WASM)
            headers: {
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
            },
            fs: {
                // Allow-list paths into the sandbox (resolves symlinks).
                allow: [
                    '.', // Current directory
                ].concat((() => {
                    const paths = [
                        CORE_PATH,
                        PROTOBUF_PATH,
                        path.dirname(SHELL_JS_PATH),
                        path.dirname(SHELL_WASM_PATH),
                        path.dirname(SVG_SYMBOLS_PATH),
                        // umap-wasm/index.js + its pkg/ subdir (glue + .wasm).
                        path.dirname(UMAP_JS_PATH),
                        path.join(path.dirname(UMAP_JS_PATH), "pkg"),
                    ]
                        .map(p => { try { return nodeFs.realpathSync(p); } catch { return p; } });
                    return paths;
                })()),
            },
        },
        optimizeDeps: {
            include: ['react', 'react-dom', 'react-router-dom'],
            exclude: [
                '@dashql/hyperdb-wasm?url',
                '@dashql/hyperdb-wasm-js?url',
                '@dashql/hyperdb-wasm-worker?url',
            ],
        },
        worker: {
            format: 'es',
            rolldownOptions: {
                output: {
                    entryFileNames: 'static/js/[name].[hash].js',
                    chunkFileNames: 'static/js/[name].[hash].js',
                    assetFileNames: (assetInfo: vite.Rollup.PreRenderedAsset) => {
                        const name = (assetInfo.names?.length > 0 ? assetInfo.names[0] : '') || '';
                        const ext = (assetInfo as { extname?: string }).extname ?? '';
                        if (/\.(wasm|wasm\.map)$/.test(name) || ext === '.wasm') return 'static/wasm/[name].[hash][extname]';
                        if (/\.(js|mjs)$/i.test(name) || ext === '.js' || ext === '.mjs') return 'static/js/[name].[hash][extname]';
                        return 'static/assets/[name].[hash][extname]';
                    },
                },
            },
        },
    };
});
