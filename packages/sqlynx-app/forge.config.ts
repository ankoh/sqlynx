import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';

import mainConfig from './webpack/webpack.electron.main';
import rendererConfig from './webpack/webpack.electron.renderer';
import preloadConfig from './webpack/webpack.electron.preload';

export default {
    makers: [new MakerSquirrel({}), new MakerZIP({}, ['darwin'])],
    plugins: [
        new WebpackPlugin({
            mainConfig: mainConfig as any,
            loggerPort: 9003,
            renderer: {
                config: rendererConfig as any,
                entryPoints: [
                    {
                        name: 'main_window',
                        html: './static/index.html',
                        js: './src/app.tsx',
                        preload: {
                            config: preloadConfig as any,
                            js: './src/electron/preload.ts',
                        },
                    },
                ],
            },
        }),
    ],
};
