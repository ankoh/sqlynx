import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import ForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';
import * as webpack from 'webpack';
import * as webpackDevServer from 'webpack-dev-server';
import path from 'path';

export type Configuration = webpack.Configuration & {
    devServer?: webpackDevServer.Configuration
};

interface ConfigParams {
    target?: string;
    entry?: any;
    buildDir?: string;
    tsLoaderOptions?: any;
    extractCss: boolean;
    cssIdentifier: string
}

export function configure(params: ConfigParams): Partial<Configuration> {
    return {
        target: params.target,
        entry: params.entry,
        output: {
            path: params.buildDir,
            filename: 'static/js/[name].[contenthash].js',
            chunkFilename: 'static/js/[name].[contenthash].js',
            assetModuleFilename: 'static/assets/[name].[contenthash][ext]',
            webassemblyModuleFilename: 'static/wasm/[hash].wasm',
            clean: true,
        },
        resolve: {
            extensions: ['.ts', '.tsx', '.js', '.mjs', '.jsx', '.css', '.wasm'],
        },
        module: {
            rules: [
                {
                    test: /\.m?js/,
                    resolve: {
                        fullySpecified: false,
                    },
                },
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
                                    localIdentContext: path.resolve(__dirname, 'src'),
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
                    test: /\.(json)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/json/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /\.(csv|tbl)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/csv/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /\.(parquet)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/parquet/[name].[contenthash][ext]',
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
                    test: /site\.webmanifest$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/[name].[contenthash][ext]',
                    },
                },
                {
                    test: /browserconfig\.xml$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'static/[name].[contenthash][ext]',
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
                template: './static/index.html',
                filename: './index.html',
            }),
            new MiniCssExtractPlugin({
                filename: './static/css/[id].[contenthash].css',
                chunkFilename: './static/css/[id].[contenthash].css',
            }),
        ],
        experiments: {
            asyncWebAssembly: true,
        },
    };
}