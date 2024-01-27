import { configure, Configuration } from './webpack.common';

const base = configure({
    target: 'web',
    tsLoaderOptions: {
        configFile: 'tsconfig.pwa.json',
        compilerOptions: {
            sourceMap: true,
        },
    },
    extractCss: true,
    cssIdentifier: '[local]_[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'http://localhost:9002',
});

const config: Configuration = {
    ...base,
    output: {
        chunkFilename: 'static/js/[name].[contenthash].js',
        assetModuleFilename: 'static/assets/[name].[contenthash][ext]',
        webassemblyModuleFilename: 'static/wasm/[hash].wasm',
        clean: false,
    },
    devtool: 'source-map',
};
export default config;
