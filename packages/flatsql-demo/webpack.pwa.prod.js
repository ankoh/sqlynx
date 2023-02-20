import { configure, GITHUB_OAUTH_VERSION } from './webpack.common.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, './dist/pwa');

const base = configure({
    buildDir,
    tsLoaderOptions: {
        compilerOptions: {
            configFile: './tsconfig.json',
            sourceMap: false,
        },
    },
    extractCss: true,
    cssIdentifier: '[hash:base64]',
    dashqlAPP: 'https://app.dashql.com',
    dashqlAPI: 'https://api.dashql.com',
    githubOAuthClientID: '286d19fc45d2e4e826d6',
    githubOAuthCallback: `https://api.dashql.com/static/html/github_oauth.${GITHUB_OAUTH_VERSION}.html`,
});

export default {
    ...base,
    entry: {
        app: ['./src/app.pwa.tsx'],
    },
    mode: 'production',
    devtool: false,
};