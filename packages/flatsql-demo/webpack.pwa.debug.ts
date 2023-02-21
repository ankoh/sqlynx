import { configure, Configuration } from './webpack.pwa.common';
import path from 'path';

const base = configure({
    target: 'web',
    entry: {
        app: ['./src/app.tsx'],
    },
    buildDir: path.resolve(__dirname, './build/pwa/debug'),
    tsLoaderOptions: {
        configFile: 'tsconfig.pwa.json',
        compilerOptions: {
            sourceMap: true,
        }
    },
    extractCss: false,
    cssIdentifier: '[local]_[hash:base64]',
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
            directory: path.join(__dirname, './build/pwa/debug/static'),
        },
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization',
            // This will enable SharedArrayBuffers in Firefox but will block most requests to third-party sites.
            //
            // "Cross-Origin-Resource-Policy": "cross-origin",
            // "Cross-Origin-Embedder-Policy": "require-corp",
            // "Cross-Origin-Opener-Policy": "same-origin"
        },
    },
};
export default config;