import { configure } from './webpack.common';
import path from 'path';

const buildDir = path.resolve(__dirname, './build/electron');
const buildDirRenderer = path.join(buildDir, 'app');
const buildDirPreload = path.join(buildDir, 'preload');

const base = configure({
    buildDir,
    tsLoaderOptions: {
        compilerOptions: {
            configFile: './tsconfig.electron.json',
            sourceMap: true,
        },
    },
    extractCss: false,
    cssIdentifier: '[local]_[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'http://localhost:9002',
});

const renderer = {
    ...base,
    target: 'electron-renderer',
    entry: {
        app: ['./src/app.tsx'],
    },
    output: {
        ...base.output,
        path: buildDirRenderer,
        publicPath: './',
        devtoolModuleFilenameTemplate: 'file:///[absolute-resource-path]', // map to source with absolute file path not webpack:// protocol
    },
    mode: 'development',
    watchOptions: {
        ignored: ['node_modules/**', 'build/**'],
    },
    performance: {
        hints: false,
    },
    devtool: 'source-map',
};

const preload = {
    ...base,
    target: 'electron-preload',
    entry: {
        preload: ['./src/electron_preload.ts'],
    },
    output: {
        ...base.output,
        path: buildDirPreload,
        filename: '[name].cjs',
        publicPath: './',
        globalObject: 'globalThis',
    },
    mode: 'development',
    plugins: [],
};

const main = {
    ...renderer,
    target: 'electron-main',
    entry: {
        electron: ['./src/electron.ts'],
    },
    output: {
        ...base.output,
        path: buildDir,
        publicPath: './',
        filename: '[name].cjs',
        chunkFilename: 'main/js/[name].[contenthash].cjs',
        assetModuleFilename: 'main/assets/[name].[contenthash][ext]',
        globalObject: 'globalThis',
        clean: {
            keep: /(app\/)|(preload\/)/,
        },
    },
    mode: 'development',
    plugins: [],
};

export default [main, preload, renderer];
