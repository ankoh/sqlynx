import { app, BrowserWindow, dialog } from 'electron';
import os from 'os';
import path from 'path';

// Handle the most common Window commands, such as managing desktop shortcuts
if (require('electron-squirrel-startup')) {
    app.quit();
}

// Collect context
const baseDir = path.dirname(process.argv[1]);
const preloadScriptPath = path.resolve(baseDir, './preload/preload.cjs');
const platform = os.platform();

// Poor-mans argument parsing, we only need to detect the debug flag
const argv = process.argv.slice(2);
let isDebug = false;
for (const arg of argv) {
    if (arg === 'debug') {
        isDebug = true;
    }
}

// Register as default protocol client
if (process.defaultApp && !isDebug) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('sqlynx', process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient('sqlynx');
}

// Don't open the app multiple times
let mainWindow: BrowserWindow | null = null;

// Instance lock for Windows and Linux
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, commandLine, _workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
        // The commandLine is array of strings in which last element is deep link url
        dialog.showErrorBox('Welcome Back', `You arrived from: ${commandLine.pop()}`);
    });

    // Create mainWindow
    app.whenReady().then(() => {
        createWindow();
    });

    // Handle the protocol
    app.on('open-url', (event, url) => {
        const appUrl = new URL(url);
        dialog.showErrorBox('Welcome Back', `You arrived from: ${appUrl.host} ${appUrl.search}`);
    });
}

const createWindow = (): void => {
    // Create the browser window
    mainWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        titleBarStyle: 'hidden',
        webPreferences: {
            preload: preloadScriptPath,
            additionalArguments: [`--platform=${platform}`],
        },
        show: false,
    });
    // Load the index.html of the app
    if (isDebug) {
        mainWindow.loadURL('http://localhost:9002');
    } else {
        mainWindow.loadFile('./app/index.html');
    }
    mainWindow.once('ready-to-show', () => {
        mainWindow!.show();
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
