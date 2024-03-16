import { configure, Configuration } from './webpack.common.js';
import * as url from 'url';

const base = configure({
    target: 'web',
    buildDir: url.fileURLToPath(new URL('../build/dev', import.meta.url)),
    tsLoaderOptions: {
        configFile: 'tsconfig.json',
        compilerOptions: {
            sourceMap: true,
        },
    },
    relocatable: false,
    extractCss: false,
    cssIdentifier: '[local]_[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'http://localhost:9002',
});

const config: Configuration = {
    ...base,
    mode: 'development',
    watchOptions: {
        ignored: ['node_modules/**', 'build/**'],
    },
    performance: {
        hints: false,
    },
    devtool: 'source-map',
    devServer: {
        historyApiFallback: true,
        compress: true,
        port: 9002,
        static: {
            directory: url.fileURLToPath(new URL('./build/pwa/dev/static', import.meta.url)),
        },
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization',
        },
    },
};
export default config;
