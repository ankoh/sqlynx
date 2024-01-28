import { configure, Configuration } from './webpack.common';
import path from 'path';

const base = configure({
    target: 'web',
    entry: {
        app: ['./src/app.tsx'],
    },
    buildDir: path.resolve(__dirname, '../build/pwa/o3'),
    tsLoaderOptions: {
        configFile: 'tsconfig.pwa.json',
        compilerOptions: {
            sourceMap: false,
        },
    },
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
