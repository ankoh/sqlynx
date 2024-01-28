import path from 'path';

import pwaConfig from './webpack.pwa.o3';
import { configure as configureMain } from './webpack.electron.common.main';
import { configure as configurePreload } from './webpack.electron.common.preload';

pwaConfig.output! = {
    ...pwaConfig.output!,
    path: path.resolve(__dirname, '../build/electron/o3/app'),
    publicPath: './'
};

export default [
    pwaConfig,
    configureMain({
        buildDir: path.resolve(__dirname, '../build/electron/o3'),
        mode: 'production',
    }),
    configurePreload({
        buildDir: path.resolve(__dirname, '../build/electron/o3/preload'),
        mode: 'production',
    })
];
