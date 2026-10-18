/// The number of bytes the body of a response will yield, or 0 if the server does not tell.
///
/// Content-Length counts the bytes on the wire. For a Content-Encoded response, such as the Brotli-compressed
/// WebAssembly of the pages build, the body stream yields the decoded bytes, which are more. Progress would run past 100%
/// if the two were compared.
export function decodedContentLength(response: Response): number {
    const encoding = response.headers.get('content-encoding');
    if (encoding != null && encoding.trim().toLowerCase() !== 'identity') {
        return 0;
    }
    const length = parseInt(response.headers.get('content-length') ?? '', 10);
    return Number.isFinite(length) && length > 0 ? length : 0;
}
