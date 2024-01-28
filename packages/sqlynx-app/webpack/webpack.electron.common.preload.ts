import webpack from 'webpack';

export type Configuration = webpack.Configuration;
export interface ConfigParams {
    mode: 'production' | 'development';
    buildDir: string;
};

export function configure(params: ConfigParams): Partial<Configuration> {
    return {
        target: 'electron-preload',
        entry: {
            preload: './src/electron/preload.ts'
        },
        output: {
            filename: '[name].cjs',
            path: params.buildDir,
            globalObject: 'globalThis',
            clean: true,
        },
        mode: params.mode,
        resolve: {
            extensions: ['.ts', '.js', '.mjs'],
        },
        devtool: params.mode == 'development' ? 'source-map' : false,
        watchOptions: {
            ignored: ['node_modules/**', 'build/**'],
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    loader: 'ts-loader',
                    exclude: /node_modules/,
                    options: {
                        compilerOptions: {
                            configFile: './tsconfig.electron.json',
                            sourceMap: false,
                        },
                    },
                },
            ],
        },
    };
};
