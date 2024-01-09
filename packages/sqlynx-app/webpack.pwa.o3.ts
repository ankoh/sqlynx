import { configure, Configuration, OAUTH_CALLBACK_VERSION } from './webpack.pwa.common';
import path from 'path';

const base = configure({
    target: 'web',
    entry: {
        app: ['./src/app.tsx'],
    },
    buildDir: path.resolve(__dirname, './build/pwa/o3'),
    tsLoaderOptions: {
        configFile: 'tsconfig.pwa.json',
        compilerOptions: {
            sourceMap: false,
        },
    },
    extractCss: true,
    cssIdentifier: '[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'https://sqlynx.app',
    githubOAuthClientID: '877379132b93adf6f705',
    githubOAuthRedirect: `http://localhost:9001/static/html/auth_callback.${OAUTH_CALLBACK_VERSION}.html`,
});

const config: Configuration = {
    ...base,
    mode: 'production',
    devtool: false,
};

export default config;
