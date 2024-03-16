import { configure, Configuration } from './webpack.common.js';
import * as url from 'url';

const base = configure({
    target: 'web',
    buildDir: url.fileURLToPath(new URL('../build/pages', import.meta.url)),
    tsLoaderOptions: {
        configFile: 'tsconfig.json',
        compilerOptions: {
            sourceMap: false,
        },
    },
    relocatable: false,
    extractCss: true,
    cssIdentifier: '[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'https://sqlynx.app',
});

const config: Configuration = {
    ...base,
    mode: 'production',
    devtool: false,
};

export default config;
