import path from 'path';
import fs from 'fs';

import pwaConfig from './webpack.pwa.release';
import { configure as configureMain } from './webpack.electron.common.main';
import { configure as configurePreload } from './webpack.electron.common.preload';

pwaConfig.output! = {
    ...pwaConfig.output!,
    path: path.resolve(__dirname, '../build/electron/release/app'),
    publicPath: './',
};

const PWA_DIR_IN = path.resolve(__dirname, '../build/pwa/release');
const PWA_DIR_OUT = path.resolve(__dirname, '../build/electron/release/app');
fs.rmSync(PWA_DIR_OUT, { recursive: true, force: true });
fs.cpSync(PWA_DIR_IN, PWA_DIR_OUT, { recursive: true });

export default [
    pwaConfig,
    configureMain({
        buildDir: path.resolve(__dirname, '../build/electron/release'),
        mode: 'production',
    }),
    configurePreload({
        buildDir: path.resolve(__dirname, '../build/electron/release/preload'),
        mode: 'production',
    }),
];
