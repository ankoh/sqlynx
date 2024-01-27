export default {
    mode: 'production',
    entry: ['./src/electron/main.ts'],
    resolve: {
        extensions: ['.ts', '.js', '.mjs'],
    },
    devtool: false,
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
