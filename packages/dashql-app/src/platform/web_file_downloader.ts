import { FileDownloader } from './file_downloader.js';

export class WebFileDownloader implements FileDownloader {
    async downloadBufferAsFile(uint8Array: Uint8Array, filename: string): Promise<void> {
        // Create a Blob from the Uint8Array
        const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
        // Create a temporary URL for the Blob
        const url = URL.createObjectURL(blob);
        // Create an anchor element and trigger the download
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        // Clean up after download
        document.body.removeChild(a);
        // Release blob memory
        URL.revokeObjectURL(url);
    }
}
