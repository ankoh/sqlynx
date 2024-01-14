import { app, BrowserWindow } from 'electron';
import path from 'path';
import process from 'process';

const baseDir = path.dirname(process.argv[1]);
const preloadScript = path.resolve(baseDir, 'preload', 'preload.cjs');

function createWindow() {
    const win = new BrowserWindow({
        width: 1000,
        height: 750,
        webPreferences: {
            nodeIntegration: true,
            preload: preloadScript,
        },
        show: false,
        autoHideMenuBar: true,
    });
    win.loadFile('./app/index.html');
    win.once('ready-to-show', () => {
        win.show();
    });
}

app.on('ready', createWindow);
