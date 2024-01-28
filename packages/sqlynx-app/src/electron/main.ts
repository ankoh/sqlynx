import { app, BrowserWindow } from 'electron';
import os from 'os';
import path from 'path';

const BASE_DIR = path.dirname(process.argv[1]);
const PRELOAD_SCRIPT = path.resolve(BASE_DIR, './preload/preload.cjs');
const PLATFORM = os.platform();

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
    app.quit();
}

const createWindow = (): void => {
    // Create the browser window.
    const mainWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        titleBarStyle: 'hidden',
        webPreferences: {
            preload: PRELOAD_SCRIPT,
            additionalArguments: [`--platform=${PLATFORM}`],
        },
        show: false,
    });
    // and load the index.html of the app.
    mainWindow.loadFile('./app/index.html');
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
