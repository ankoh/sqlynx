import { configure, Configuration } from './webpack.common.js';
import * as url from 'url';

const base = configure({
    mode: 'production',
    target: 'web',
    buildDir: url.fileURLToPath(new URL('../build/reloc', import.meta.url)),
    tsLoaderOptions: {
        configFile: 'tsconfig.json',
        compilerOptions: {
            sourceMap: false,
        },
    },
    relocatable: true,
    extractCss: true,
    cssIdentifier: '[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'https://sqlynx.app',
});

const config: Configuration = {
    ...base,
    devtool: false,
};

export default config;
