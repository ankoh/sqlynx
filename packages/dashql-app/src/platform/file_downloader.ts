
export interface FileDownloader {
    /// Download a buffer as file
    downloadBufferAsFile(uint8Array: Uint8Array, filename: string): Promise<void>;
}
