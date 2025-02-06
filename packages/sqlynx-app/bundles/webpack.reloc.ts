import webpack from 'webpack';
import * as webpackDevServer from 'webpack-dev-server';
import * as url from 'url';

import { configure } from './webpack.common.js';

export type Configuration = webpack.Configuration & {
    devServer?: webpackDevServer.Configuration;
};

const base = configure({
    mode: 'production',
    target: 'web',
    buildDir: url.fileURLToPath(new URL('../build/reloc', import.meta.url)),
    tsLoaderOptions: {
        compilerOptions: {
            sourceMap: false,
        },
    },
    relocatable: true,
    extractCss: true,
    cssIdentifier: '[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'https://sqlynx.app',
    logLevel: process.env.SQLYNX_LOG_LEVEL ?? 'info',
});

const config: Configuration = {
    ...base,
    devtool: false,
};

export default config;
