import path from 'path';
import { configure, Configuration } from './webpack.common';

const base = configure({
    target: 'web',
    entry: {
        app: ['./src/app.tsx'],
    },
    buildDir: path.resolve(__dirname, './build/electron/renderer'),
    tsLoaderOptions: {
        configFile: 'tsconfig.pwa.json',
        compilerOptions: {
            sourceMap: true,
        },
    },
    extractCss: false,
    cssIdentifier: '[local]_[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'http://localhost:9002',
});

const config: Configuration = {
    ...base,
    mode: 'production',
    output: {
        chunkFilename: 'static/js/[name].[contenthash].js',
        assetModuleFilename: 'static/assets/[name].[contenthash][ext]',
        webassemblyModuleFilename: 'static/wasm/[hash].wasm',
    },
    devtool: 'source-map',
};
export default config;
