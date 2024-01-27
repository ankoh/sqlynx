import { contextBridge } from 'electron';
import os from 'os';

const platformArgV = process.argv.filter(p => p.indexOf('--platform=') >= 0)[0];
const platformArg = platformArgV.substring(platformArgV.indexOf('=') + 1);

contextBridge.exposeInMainWorld('electron', {
    platform: platformArg,
});
