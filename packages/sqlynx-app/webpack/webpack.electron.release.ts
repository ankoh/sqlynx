import path from 'path';

import pwaConfig from './webpack.pwa.release';
import { configure as configureMain } from './webpack.electron.common.main';
import { configure as configurePreload } from './webpack.electron.common.preload';

pwaConfig.output! = {
    ...pwaConfig.output!,
    path: path.resolve(__dirname, '../build/electron/release/app'),
    publicPath: './'
};

export default [
    pwaConfig,
    configureMain({
        buildDir: path.resolve(__dirname, '../build/electron/release'),
        mode: 'production',
    }),
    configurePreload({
        buildDir: path.resolve(__dirname, '../build/electron/release/preload'),
        mode: 'production',
    })
];
