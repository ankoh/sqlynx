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
            sourceMap: false,
        },
    },
    extractCss: true,
    cssIdentifier: '[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'https://sqlynx.app',
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
    },
    mode: 'production',
    devtool: false,
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
    mode: 'production',
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
        chunkFilename: 'js/[name].[contenthash].cjs',
        assetModuleFilename: 'assets/[name].[contenthash][ext]',
        globalObject: 'globalThis',
        clean: {
            keep: /app\//,
        },
    },
    mode: 'production',
    plugins: [],
};

export default [renderer, preload, main];
