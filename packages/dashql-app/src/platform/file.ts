
export interface PlatformFile {
    /// The file path
    readonly path: string;

    /// Read the file as array buffer
    readAsArrayBuffer(): Promise<Uint8Array>;
}
