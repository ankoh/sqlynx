import { configure } from './webpack.common';
import path from 'path';

const buildDir = path.resolve(__dirname, './build/electron');
const buildDirRenderer = path.join(buildDir, 'app');
const buildDirPreload = path.join(buildDir, 'preload');

const pwaBase = configure({
    buildDir,
    tsLoaderOptions: {
        compilerOptions: {
            configFile: './tsconfig.pwa.json',
            sourceMap: true,
        },
    },
    extractCss: false,
    cssIdentifier: '[local]_[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'http://localhost:9002',
});

const renderer = {
    ...pwaBase,
    target: 'electron-renderer',
    entry: {
        app: ['./src/app.tsx'],
    },
    output: {
        path: buildDirRenderer,
        publicPath: './',
        filename: '[name].js',
        chunkFilename: 'app/js/[name].[contenthash].js',
        assetModuleFilename: 'app/assets/[name].[contenthash][ext]',
        globalObject: 'globalThis',
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

const electronBase = configure({
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

const preload = {
    ...electronBase,
    target: 'electron-preload',
    entry: {
        preload: ['./src/electron_preload.ts'],
    },
    output: {
        path: buildDirPreload,
        filename: '[name].cjs',
        publicPath: './',
        chunkFilename: 'preload/js/[name].[contenthash].cjs',
        assetModuleFilename: 'preload/assets/[name].[contenthash][ext]',
        globalObject: 'globalThis',
    },
    mode: 'development',
    plugins: [],
};

const main = {
    ...electronBase,
    target: 'electron-main',
    entry: {
        electron: ['./src/electron.ts'],
    },
    output: {
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
