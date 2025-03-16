import { PlatformFile } from "./file.js";

export class WebFile implements PlatformFile {
    /// The file name
    public readonly path: string;
    /// The file
    public readonly file: File;

    /// The constructor
    constructor(file: File, path: string) {
        this.path = path;
        this.file = file;
    }
    /// Read the file as array buffer
    async readAsArrayBuffer(): Promise<Uint8Array> {
        const fileBytes = await this.file.arrayBuffer();
        return new Uint8Array(fileBytes);
    }
}
