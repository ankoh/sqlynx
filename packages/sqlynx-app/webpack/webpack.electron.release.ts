import path from 'path';
import fs from 'fs';

import { configure as configureMain } from './webpack.electron.common.main';
import { configure as configurePreload } from './webpack.electron.common.preload';

const ELECTRON_DIR = path.resolve(__dirname, '../build/electron/release');
const PWA_DIR_IN = path.resolve(__dirname, '../build/pwa/release');
const PWA_DIR_OUT = path.resolve(__dirname, '../build/electron/release/app');
fs.mkdirSync(ELECTRON_DIR, { recursive: true });
fs.rmSync(PWA_DIR_OUT, { recursive: true, force: true });
fs.cpSync(PWA_DIR_IN, PWA_DIR_OUT, { recursive: true });

export default [
    configureMain({
        buildDir: path.resolve(__dirname, '../build/electron/release'),
        mode: 'production',
    }),
    configurePreload({
        buildDir: path.resolve(__dirname, '../build/electron/release/preload'),
        mode: 'production',
    }),
];
