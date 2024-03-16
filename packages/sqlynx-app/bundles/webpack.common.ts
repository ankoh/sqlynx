import CopyWebpackPlugin from 'copy-webpack-plugin';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import ForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';
import * as childProcess from 'child_process';
import webpack from 'webpack';
import * as webpackDevServer from 'webpack-dev-server';
import * as url from 'url';
import * as fs from 'fs';

export type Configuration = webpack.Configuration & {
    devServer?: webpackDevServer.Configuration;
};

interface ConfigParams {
    target?: string;
    buildDir?: string;
    tsLoaderOptions?: any;
    relocatable: boolean;
    extractCss: boolean;
    cssIdentifier: string;
    appURL: string;
}

// Read package json
const PACKAGE_JSON_PATH = url.fileURLToPath(new URL('../package.json', import.meta.url));
const PACKAGE_JSON = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { version: string; gitCommit: string; };

/// IMPORTANT
///
/// We use a dedicated tiny html file for the OAuth callback to not inflate the whole app in the popup.
/// However the EXACT OAuth callback URI has to be configured in the apps web interface.
/// If we would load the file using webpacks [contenthash], we would get cache busting but could break OAuth for our users without really noticing it.
//
/// We therefore use an explicit version file.
/// If you don't change the version file, you don't have to change the redirect URI but an updated file won't bust the CDN cache.
/// If you change the version file, you have to change the redirect URI and get cache busting automatically.
const OAUTH_CALLBACK_VERSION_FILE = url.fileURLToPath(new URL('../src/connectors/oauth_callback.html.version', import.meta.url));
export const OAUTH_CALLBACK_VERSION = childProcess.execSync(`cat ${OAUTH_CALLBACK_VERSION_FILE}`).toString().trim();

/// We support dynamic configurations of DashQL via a dedicated config file.
/// The app loads this file at startup which allows us to adjust certain settings dynamically.
//
/// By default, the name of this config file includes the content hash for our own cache-busting.
/// A more "generic" build of DashQL should set this path to 'static/config.json'.
/// For example, we may want to provide a docker image for on-premise deployments that mounts a user-provided config.
const CONFIG_PATH = 'static/config.[contenthash].json';

export function configure(params: ConfigParams): Partial<Configuration> {
    return {
        target: params.target,
        entry: {
            'app': ['./src/app.tsx'],
            'oauth_redirect': ['./src/oauth_redirect.tsx'],
        },
        output: {
            path: params.buildDir,
            filename: 'static/js/[name].[contenthash].js',
            chunkFilename: 'static/js/[name].[contenthash].js',
            assetModuleFilename: 'static/assets/[name].[contenthash][ext]',
            webassemblyModuleFilename: 'static/wasm/[hash].wasm',
            globalObject: 'globalThis',
            clean: true,
        },
        resolve: {
            extensions: ['.ts', '.tsx', '.js', '.mjs', '.jsx', '.css', '.wasm'],
            extensionAlias: {
                '.js': ['.js', '.jsx', '.ts', '.tsx'],
            },
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    loader: 'ts-loader',
                    exclude: /node_modules/,
                    options: params.tsLoaderOptions,
                },
                {
                    test: /\.css$/,
                    use: [
                        params.extractCss ? MiniCssExtractPlugin.loader : 'style-loader',
                        {
                            loader: 'css-loader',
                            options: {
                                modules: {
                                    mode: 'local',
                                    auto: true,
                                    exportGlobals: true,
                                    localIdentName: params.cssIdentifier,
                                    localIdentContext: url.fileURLToPath(new URL('src', import.meta.url)),
                                },
                            },
                        },
                    ],
                },
                {
                    test: /.*\.wasm$/,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/wasm/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /\.(sql)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/scripts/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /\.(png|jpe?g|gif|svg|ico)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/img/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /\.(ttf)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/fonts/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /.*\/static\/config\.json$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: CONFIG_PATH,
                    },
                },
                {
                    test: /.*oauth_callback\.html$/,
                    type: 'asset/resource',
                    generator: {
                        filename: `static/html/[name].${OAUTH_CALLBACK_VERSION}[ext]`,
                    },
                },
            ],
        },
        optimization: {
            usedExports: 'global',
            chunkIds: 'deterministic',
            moduleIds: 'deterministic',
            splitChunks: {
                chunks: 'all',
                cacheGroups: {
                    vendors: {
                        test: /[\\/]node_modules[\\/]/,
                        priority: -10,
                    },
                    default: {
                        priority: -20,
                        reuseExistingChunk: true,
                    },
                },
            },
        },
        plugins: [
            new ForkTsCheckerWebpackPlugin(),
            new HtmlWebpackPlugin({
                chunks: ['app'],
                template: './static/index.html',
                filename: './index.html',
                base: params.relocatable ? './' : '/',
            }),
            new HtmlWebpackPlugin({
                chunks: ['oauth_redirect'],
                template: './static/oauth_redirect.html',
                filename: './oauth_redirect.html',
                base: params.relocatable ? './' : '/',
            }),
            new webpack.DefinePlugin({
                'process.env.SQLYNX_VERSION': JSON.stringify(PACKAGE_JSON.version),
                'process.env.SQLYNX_GIT_COMMIT': JSON.stringify(PACKAGE_JSON.gitCommit),
                'process.env.SQLYNX_APP_URL': JSON.stringify(params.appURL),
                'process.env.SQLYNX_RELATIVE_IMPORTS': params.relocatable,
            }),
            // Leave the public path at default, otherwise the css extraction will mess up urls:
            // https://github.com/webpack-contrib/mini-css-extract-plugin/issues/691#issuecomment-871524582
            new MiniCssExtractPlugin({
                filename: './static/css/[id].[contenthash].css',
                chunkFilename: './static/css/[id].[contenthash].css',
            }),
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: './static/favicons',
                        to: './static/favicons',
                    },
                ],
            }),
        ],
        experiments: {
            asyncWebAssembly: true,
        },
    };
}
