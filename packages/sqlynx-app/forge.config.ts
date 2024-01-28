import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';

import mainConfig from './webpack/webpack.electron.main';
import rendererConfig from './webpack/webpack.electron.renderer';
import preloadConfig from './webpack/webpack.electron.preload';

export default {
    makers: [new MakerSquirrel({}, ['win32']), new MakerDMG({}, ['darwin']), new MakerZIP({}, ['linux'])],
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
