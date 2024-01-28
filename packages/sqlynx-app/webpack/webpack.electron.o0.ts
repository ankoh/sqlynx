import path from 'path';

import { configure as configureMain } from './webpack.electron.common.main';
import { configure as configurePreload } from './webpack.electron.common.preload';

export default [
    configureMain({
        buildDir: path.resolve(__dirname, '../build/electron/o0'),
        mode: 'development',
    }),
    configurePreload({
        buildDir: path.resolve(__dirname, '../build/electron/o0/preload'),
        mode: 'development',
    })
];
