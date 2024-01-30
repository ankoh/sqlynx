import { app, BrowserWindow, dialog } from 'electron';
import os from 'os';
import path from 'path';

// Handle the most common Windows commands, such as managing desktop shortcuts
if (require('electron-squirrel-startup')) {
    app.quit();
}

// Poor-mans argument parsing, we only need to detect the debug flag at the moment
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

const baseDir = path.dirname(process.argv[1]);
const preloadScriptPath = path.resolve(baseDir, './preload/preload.cjs');
const platform = os.platform();
let mainWindow: BrowserWindow | null = null;

// Helper to create the main window
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

// Make sure we're the main app instance
const mainWindowLock = app.requestSingleInstanceLock();
if (!mainWindowLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, commandLine, _workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window instead.
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

// This method will be called when Electron has finished initialization and is ready to create browser windows.
app.on('ready', createWindow);

// Quit when all windows are closed.
// On macOS, guides recommend to let the app run in the background and only "recreate" the window later.
// We will not do that initially until we learn how this interferes with auto-updates.
app.on('window-all-closed', () => {
    app.quit();
});
