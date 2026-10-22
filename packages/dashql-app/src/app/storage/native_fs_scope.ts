/// Grant the native filesystem scope for a directory.
///
/// Electron validates absolute paths in the main process and therefore does not require a separate
/// runtime scope grant. Keep this compatibility hook while the storage backend uses shared routing.
export async function grantFsScope(path: string): Promise<void> {
    void path;
}
