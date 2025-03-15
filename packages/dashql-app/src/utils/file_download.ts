
export function downloadBufferAsFile(uint8Array: Uint8Array, filename: string, mimeType: string = 'application/octet-stream') {
    // Create a Blob from the Uint8Array
    const blob = new Blob([uint8Array], { type: mimeType });
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
