import { configure, Configuration, OAUTH_CALLBACK_VERSION } from './webpack.pwa.common';
import path from 'path';

const base = configure({
    target: 'web',
    entry: {
        app: ['./src/app.tsx'],
    },
    buildDir: path.resolve(__dirname, './build/pwa/o0'),
    tsLoaderOptions: {
        configFile: 'tsconfig.pwa.json',
        compilerOptions: {
            sourceMap: true,
        },
    },
    extractCss: false,
    cssIdentifier: '[local]_[hash:base64]',
    appURL: process.env.SQLYNX_APP_URL ?? 'http://localhost:9002',
    githubOAuthClientID: '877379132b93adf6f705',
    githubOAuthRedirect: `http://localhost:9001/static/html/auth_callback.${OAUTH_CALLBACK_VERSION}.html`,
});

const config: Configuration = {
    ...base,
    mode: 'development',
    watchOptions: {
        ignored: ['node_modules/**', 'dist/**'],
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
            directory: path.join(__dirname, './build/pwa/o0/static'),
        },
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization',
        },
    },
};
export default config;
