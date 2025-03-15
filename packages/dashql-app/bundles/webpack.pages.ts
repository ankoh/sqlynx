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
    buildDir: url.fileURLToPath(new URL('../build/pages', import.meta.url)),
    tsLoaderOptions: {
        compilerOptions: {
            sourceMap: false,
        },
    },
    relocatable: false,
    extractCss: true,
    cssIdentifier: '[hash:base64]',
    appURL: process.env.DASHQL_APP_URL ?? 'https://dashql.app',
    logLevel: process.env.DASHQL_LOG_LEVEL ?? 'info',
});

const config: Configuration = {
    ...base,
    devtool: false,
};

export default config;
