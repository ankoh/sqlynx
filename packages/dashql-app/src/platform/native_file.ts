import { readFile } from '@tauri-apps/plugin-fs';
import { PlatformFile } from './file.js';

export class NativeFile implements PlatformFile {
    /// The file path
    public readonly path: string;

    /// The constructor
    constructor(path: string) {
        this.path = path;
    }
    /// Read the file as array buffer
    async readAsArrayBuffer(): Promise<Uint8Array> {
        const file = await readFile(this.path);
        return file;
    }
}
