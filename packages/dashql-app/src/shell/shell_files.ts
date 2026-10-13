import type {
    EmbeddedExternalDirectoryDatabase,
    EmbeddedExternalFileDatabase,
    ExternalDirectoryMode,
} from '../platform/database/embedded_database.js';
import type { FileDownloader } from '../platform/file/file_downloader.js';
import type { PlatformFile } from '../platform/file/file.js';
import { HYPER_OPFS_ROOT, SHELL_FILES_DIRECTORY } from '../platform/hyperdb/hyperdb_opfs.js';
import { stringifyError, type LoggerLike } from '../platform/logger/logger.js';
import type { DashQLShellCommand, DashQLShellCommandContext } from './api.js';

const LOG_CTX = 'standalone_shell_files';

interface ShellFileEntry {
    readonly path: string;
    size(): Promise<number | undefined>;
    read(): Promise<Uint8Array>;
    drop(): Promise<void>;
}

interface ShellFileListing {
    readonly path: string;
    readonly size?: number;
    readonly directoryMode?: ExternalDirectoryMode;
}

interface FileOperationOptions {
    readonly signal?: AbortSignal;
    readonly onProgress?: (message: string) => void;
}

export class ShellFileRegistry {
    private readonly files = new Map<string, ShellFileEntry>();
    private readonly directories = new Map<string, ExternalDirectoryMode>();
    private readonly mountedPaths = new Set<string>();
    private disposed = false;

    constructor(
        private readonly native: boolean = false,
        private readonly getOPFSRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
        private readonly logger?: LoggerLike,
        private readonly externalFiles?: EmbeddedExternalFileDatabase,
        private readonly externalDirectories?: EmbeddedExternalDirectoryDatabase,
    ) {}

    async list(): Promise<readonly string[]> {
        return (await this.listFiles()).map(file => file.path);
    }

    async listFiles(): Promise<readonly ShellFileListing[]> {
        if (this.native) {
            const files = await Promise.all(Array.from(this.files.values(), async file => ({
                path: file.path,
                size: await file.size(),
            })));
            return files.sort((a, b) => a.path.localeCompare(b.path));
        }
        const directory = await this.getOPFSDirectory();
        const files: ShellFileListing[] = [];
        for (const path of this.mountedPaths) {
            files.push({ path, size: await this.files.get(path)?.size() });
        }
        for (const [path, directoryMode] of this.directories) {
            files.push({ path, directoryMode });
        }
        for await (const [name, handle] of directory.entries()) {
            if (handle.kind === 'file') files.push({
                path: this.opfsPath(name),
                size: (await handle.getFile()).size,
            });
        }
        return files.sort((a, b) => a.path.localeCompare(b.path));
    }

    async add(file: PlatformFile, options: FileOperationOptions = {}): Promise<string> {
        return await this.importFile(file, options);
    }

    async importFile(file: PlatformFile, options: FileOperationOptions = {}): Promise<string> {
        this.checkUsable();
        throwIfAborted(options.signal);
        const entry = this.native ? nativeEntry(file) : await this.copyToOPFS(file, options);
        this.files.set(entry.path, entry);
        return entry.path;
    }

    async mountFile(file: PlatformFile, options: FileOperationOptions = {}): Promise<string> {
        this.checkUsable();
        if (this.externalFiles == null) throw new Error('external browser files are not supported');
        if (file.blob == null) throw new Error(`file cannot be mounted directly: ${file.path}`);
        throwIfAborted(options.signal);

        const startedAt = Date.now();
        const name = fileName(file.path);
        this.logger?.info('Mounting shell file', logDetails(file.path, undefined, file.size, 'register_external_file', startedAt), LOG_CTX);
        let path: string | null = null;
        try {
            options.onProgress?.(`Mounting ${name}`);
            path = await this.externalFiles.registerExternalFile(name, file.blob, options.signal);
            if (this.disposed || options.signal?.aborted) {
                await this.externalFiles.removeExternalFile(path);
                throw options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
            }
            const entry: ShellFileEntry = {
                path,
                size: async () => file.size ?? file.blob!.size,
                read: () => file.readAsArrayBuffer(),
                drop: () => this.externalFiles!.removeExternalFile(path!),
            };
            this.files.set(path, entry);
            this.mountedPaths.add(path);
            this.logger?.info('Mounted shell file', logDetails(file.path, path, file.size, 'complete', startedAt), LOG_CTX);
            return path;
        } catch (error) {
            this.logger?.error('Failed to mount shell file', {
                ...logDetails(file.path, path ?? undefined, file.size, 'register_external_file', startedAt),
                error: stringifyError(error),
                error_name: error instanceof Error ? error.name : undefined,
            }, LOG_CTX);
            throw error;
        }
    }

    async mountDirectory(handle: FileSystemDirectoryHandle, mode: ExternalDirectoryMode): Promise<string> {
        this.checkUsable();
        if (this.externalDirectories == null) throw new Error('external browser directories are not supported');
        const startedAt = Date.now();
        this.logger?.info('Mounting shell directory', logDetails(handle.name, undefined, undefined, 'register_external_directory', startedAt), LOG_CTX);
        let path: string | null = null;
        try {
            path = await this.externalDirectories.registerExternalDirectory(handle, mode);
            if (this.disposed) {
                await this.externalDirectories.removeExternalDirectory(path);
                throw new Error('shell file registry is disposed');
            }
            this.directories.set(path, mode);
            this.logger?.info('Mounted shell directory', {
                ...logDetails(handle.name, path, undefined, 'complete', startedAt),
                mode,
            }, LOG_CTX);
            return path;
        } catch (error) {
            this.logger?.error('Failed to mount shell directory', {
                ...logDetails(handle.name, path ?? undefined, undefined, 'register_external_directory', startedAt),
                mode,
                error: stringifyError(error),
                error_name: error instanceof Error ? error.name : undefined,
            }, LOG_CTX);
            throw error;
        }
    }

    async drop(path: string): Promise<boolean> {
        if (this.directories.has(path)) {
            await this.externalDirectories!.removeExternalDirectory(path);
            this.directories.delete(path);
            return true;
        }
        const registeredPath = this.native || this.files.has(path) ? path : this.canonicalOPFSPath(path);
        const entry = this.files.get(registeredPath);
        if (entry != null) {
            await entry.drop();
            this.files.delete(registeredPath);
            this.mountedPaths.delete(registeredPath);
            return true;
        }
        if (this.native) return false;
        const name = this.opfsFileName(path);
        try {
            const directory = await this.getOPFSDirectory();
            await directory.getFileHandle(name, { create: false });
            if (this.externalFiles != null) await this.externalFiles.removeOPFSFile(path);
            else await directory.removeEntry(name);
            return true;
        } catch (error) {
            if ((error as DOMException).name === 'NotFoundError') return false;
            throw error;
        }
    }

    async get(path: string): Promise<ShellFileEntry | undefined> {
        const registeredPath = this.native || this.files.has(path) ? path : this.canonicalOPFSPath(path);
        const registered = this.files.get(registeredPath);
        if (registered != null) return registered;
        if (this.native) return undefined;
        const name = this.opfsFileName(path);
        try {
            const directory = await this.getOPFSDirectory();
            const handle = await directory.getFileHandle(name, { create: false });
            return this.opfsEntry(directory, handle, name);
        } catch (error) {
            if ((error as DOMException).name === 'NotFoundError') return undefined;
            throw error;
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        for (const path of Array.from(this.mountedPaths)) {
            const entry = this.files.get(path);
            if (entry == null) continue;
            try {
                await entry.drop();
                this.files.delete(path);
                this.mountedPaths.delete(path);
            } catch (error) {
                this.logger?.warn('Failed to unmount shell file during disposal', {
                    path,
                    error: stringifyError(error),
                }, LOG_CTX);
            }
        }
        for (const path of Array.from(this.directories.keys())) {
            try {
                await this.externalDirectories!.removeExternalDirectory(path);
                this.directories.delete(path);
            } catch (error) {
                this.logger?.warn('Failed to unmount shell directory during disposal', {
                    path,
                    error: stringifyError(error),
                }, LOG_CTX);
            }
        }
    }

    private async copyToOPFS(file: PlatformFile, options: FileOperationOptions): Promise<ShellFileEntry> {
        const name = fileName(file.path);
        const path = this.opfsPath(name);
        const startedAt = Date.now();
        let stage = 'resolve_opfs_directory';
        let bytesCopied = 0;
        let destinationExisted = false;
        let externalFilePrepared = false;
        let directory: FileSystemDirectoryHandle | null = null;
        this.logger?.info('Importing shell file to OPFS', logDetails(file.path, path, file.size, stage, startedAt), LOG_CTX);

        try {
            directory = await this.getOPFSDirectory();
            stage = 'resolve_opfs_file';
            let handle: FileSystemFileHandle | null = null;
            try {
                handle = await directory.getFileHandle(name, { create: false });
                destinationExisted = true;
            } catch (error) {
                if ((error as DOMException).name !== 'NotFoundError') throw error;
            }

            if (this.externalFiles != null && file.blob != null) {
                stage = 'stream_opfs_file';
                options.onProgress?.(formatImportProgress(name, 0, file.size));
                await this.externalFiles.importOPFSFile(path, file.blob, {
                    signal: options.signal,
                    onProgress: bytesWritten => {
                        bytesCopied = bytesWritten;
                        options.onProgress?.(formatImportProgress(name, bytesWritten, file.size));
                    },
                });
            } else if (this.externalFiles != null) {
                stage = 'prepare_hyperdb_opfs_file';
                await this.externalFiles.prepareOPFSFile(path);
                externalFilePrepared = true;
                await this.streamToOPFS(file, path, name, options, bytes => { bytesCopied = bytes; });
                externalFilePrepared = false;
            } else {
                if (handle == null) handle = await directory.getFileHandle(name, { create: true });
                throwIfAborted(options.signal);
                const source = file.stream();
                stage = 'create_opfs_writable';
                const writable = await handle.createWritable();
                const total = file.size;
                let lastProgressAt = 0;
                let writableClosed = false;
                stage = 'stream_opfs_file';
                options.onProgress?.(formatImportProgress(name, 0, total));
                const reader = source.getReader();
                try {
                    for (;;) {
                        throwIfAborted(options.signal);
                        const { done, value } = await reader.read();
                        if (done) break;
                        throwIfAborted(options.signal);
                        await writable.write(value as Uint8Array<ArrayBuffer>);
                        bytesCopied += value.byteLength;
                        const now = Date.now();
                        if (now - lastProgressAt >= 100 || bytesCopied === total) {
                            options.onProgress?.(formatImportProgress(name, bytesCopied, total));
                            lastProgressAt = now;
                        }
                    }
                    stage = 'close_opfs_file';
                    await writable.close();
                    writableClosed = true;
                } catch (error) {
                    const cleanup = [reader.cancel(error)];
                    if (!writableClosed && typeof writable.abort === 'function') cleanup.push(writable.abort(error));
                    await Promise.allSettled(cleanup);
                    throw error;
                } finally {
                    reader.releaseLock();
                }
            }
            this.logger?.info('Imported shell file to OPFS', {
                ...logDetails(file.path, path, file.size ?? bytesCopied, 'complete', startedAt),
                bytes_copied: bytesCopied.toString(),
                destination_existed: destinationExisted.toString(),
            }, LOG_CTX);
            directory = await this.getOPFSDirectory();
            handle = await directory.getFileHandle(name, { create: false });
            return this.opfsEntry(directory, handle, name);
        } catch (error) {
            let cleanupError: unknown;
            if (externalFilePrepared && this.externalFiles != null) {
                try {
                    await this.externalFiles.abortOPFSFile(path);
                } catch (candidate) {
                    cleanupError = candidate;
                }
            } else if (!destinationExisted && directory != null) {
                try {
                    await directory.removeEntry(name);
                } catch (candidate) {
                    if ((candidate as DOMException).name !== 'NotFoundError') cleanupError = candidate;
                }
            }
            this.logger?.error('Failed to import shell file to OPFS', {
                ...logDetails(file.path, path, file.size, stage, startedAt),
                bytes_copied: bytesCopied.toString(),
                destination_existed: destinationExisted.toString(),
                error: stringifyError(error),
                error_name: error instanceof Error ? error.name : undefined,
                cleanup_error: cleanupError == null ? undefined : stringifyError(cleanupError),
            }, LOG_CTX);
            throw error;
        }
    }

    private async streamToOPFS(
        file: PlatformFile,
        path: string,
        name: string,
        options: FileOperationOptions,
        onBytesCopied: (bytes: number) => void,
    ): Promise<void> {
        const source = file.stream();
        const reader = source.getReader();
        let bytesCopied = 0;
        let lastProgressAt = 0;
        options.onProgress?.(formatImportProgress(name, 0, file.size));
        try {
            for (;;) {
                throwIfAborted(options.signal);
                const { done, value } = await reader.read();
                if (done) break;
                throwIfAborted(options.signal);
                await this.externalFiles!.writeOPFSFile(path, value, bytesCopied);
                bytesCopied += value.byteLength;
                onBytesCopied(bytesCopied);
                const now = Date.now();
                if (now - lastProgressAt >= 100 || bytesCopied === file.size) {
                    options.onProgress?.(formatImportProgress(name, bytesCopied, file.size));
                    lastProgressAt = now;
                }
            }
            await this.externalFiles!.finishOPFSFile(path);
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }

    private async getOPFSDirectory(): Promise<FileSystemDirectoryHandle> {
        return await (await this.getOPFSRoot()).getDirectoryHandle(SHELL_FILES_DIRECTORY, { create: true });
    }

    private opfsEntry(
        directory: FileSystemDirectoryHandle,
        handle: FileSystemFileHandle,
        name: string,
    ): ShellFileEntry {
        return {
            path: this.opfsPath(name),
            size: async () => (await handle.getFile()).size,
            read: async () => new Uint8Array(await (await handle.getFile()).arrayBuffer()),
            drop: async () => this.externalFiles != null
                ? this.externalFiles.removeOPFSFile(this.opfsPath(name))
                : directory.removeEntry(name),
        };
    }

    private opfsPath(name: string): string {
        return `${HYPER_OPFS_ROOT}/${SHELL_FILES_DIRECTORY}/${name}`;
    }

    private opfsFileName(path: string): string {
        const prefix = `${HYPER_OPFS_ROOT}/${SHELL_FILES_DIRECTORY}/`;
        if (prefix == null || path.slice(prefix.length) !== fileName(path)) {
            throw new Error(`invalid shell file path: ${path}`);
        }
        return path.slice(prefix.length);
    }

    private canonicalOPFSPath(path: string): string {
        return this.opfsPath(this.opfsFileName(path));
    }

    private checkUsable(): void {
        if (this.disposed) throw new Error('shell file registry is disposed');
    }
}

export function createShellFilesCommand(
    registry: ShellFileRegistry,
    downloader: FileDownloader,
    selectFiles: (signal?: AbortSignal) => Promise<readonly PlatformFile[]> = selectPlatformFiles,
    logger?: LoggerLike,
    selectDirectory: (mode: ExternalDirectoryMode) => Promise<FileSystemDirectoryHandle> = selectPlatformDirectory,
): DashQLShellCommand {
    return [
        'fs',
        'Manage queryable files: list, mount, mount-dir, mount-dir-rw, import, add, drop, or get',
        async (args, context) => {
            const [action = 'list', ...pathParts] = args;
            const path = pathParts.join(' ');
            switch (action) {
                case 'list': {
                    if (path.length !== 0) throw new Error('usage: .fs list');
                    const files = await registry.listFiles();
                    return files.length === 0
                        ? 'No files registered'
                        : files.map(file => file.directoryMode == null
                            ? `${file.path}${file.size == null ? '' : ` (${formatBytes(file.size)})`}`
                            : `${file.path} (directory, ${file.directoryMode === 'read' ? 'read-only' : 'read/write'})`)
                            .join('\r\n');
                }
                case 'add':
                case 'import':
                case 'mount': {
                    if (path.length !== 0) throw new Error(`usage: .fs ${action}`);
                    const selected = await selectShellFiles(selectFiles, context, logger);
                    const paths: string[] = [];
                    for (const file of selected) {
                        throwIfAborted(context.signal);
                        paths.push(action === 'mount'
                            ? await registry.mountFile(file, context)
                            : await registry.importFile(file, context));
                    }
                    if (paths.length === 0) return 'No files selected';
                    if (action === 'mount') return paths.join('\r\n');
                    const verb = action === 'import' ? 'Imported' : 'Added';
                    return `${verb} ${paths.length} file${paths.length === 1 ? '' : 's'}\r\n${paths.join('\r\n')}`;
                }
                case 'mount-dir':
                case 'mount-dir-rw': {
                    if (path.length !== 0) throw new Error(`usage: .fs ${action}`);
                    const mode: ExternalDirectoryMode = action === 'mount-dir' ? 'read' : 'readwrite';
                    return await registry.mountDirectory(await selectDirectory(mode), mode);
                }
                case 'drop': {
                    if (path.length === 0) throw new Error('usage: .fs drop <path>');
                    if (!await registry.drop(path)) throw new Error(`file not registered: ${path}`);
                    return `Dropped ${path}`;
                }
                case 'get': {
                    if (path.length === 0) throw new Error('usage: .fs get <path>');
                    const file = await registry.get(path);
                    if (file == null) throw new Error(`file not registered: ${path}`);
                    await downloader.downloadBufferAsFile(await file.read(), fileName(path));
                    return `Downloaded ${path}`;
                }
                default:
                    throw new Error('usage: .fs [list|mount|mount-dir|mount-dir-rw|import|add|drop|get]');
            }
        },
    ];
}

async function selectShellFiles(
    selectFiles: (signal?: AbortSignal) => Promise<readonly PlatformFile[]>,
    context: DashQLShellCommandContext,
    logger?: LoggerLike,
): Promise<readonly PlatformFile[]> {
    logger?.info('Opening shell file picker', {}, LOG_CTX);
    try {
        const selected = await selectFiles(context.signal);
        logger?.info('Selected shell files', {
            file_count: selected.length.toString(),
            total_size_bytes: selected.every(file => file.size != null)
                ? selected.reduce((total, file) => total + (file.size ?? 0), 0).toString()
                : undefined,
        }, LOG_CTX);
        return selected;
    } catch (error) {
        logger?.error('Failed to select shell files', {
            error: stringifyError(error),
            error_name: error instanceof Error ? error.name : undefined,
        }, LOG_CTX);
        throw error;
    }
}

function logDetails(
    sourcePath: string,
    targetPath: string | undefined,
    sizeBytes: number | undefined,
    stage: string,
    startedAt: number,
): Record<string, string | undefined> {
    return {
        source_path: sourcePath,
        target_path: targetPath,
        size_bytes: sizeBytes?.toString(),
        stage,
        elapsed_ms: (Date.now() - startedAt).toString(),
    };
}

async function selectPlatformFiles(signal?: AbortSignal): Promise<readonly PlatformFile[]> {
    const { WebFile } = await import('../platform/file/web_file.js');
    return await new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        let settled = false;
        const finish = (files?: readonly PlatformFile[], error?: unknown) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            input.remove();
            if (error != null) reject(error);
            else resolve(files ?? []);
        };
        const onAbort = () => finish(undefined, signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        input.addEventListener('change', () => {
            finish(Array.from(input.files ?? [], file => new WebFile(file, file.name)));
        }, { once: true });
        input.addEventListener('cancel', () => finish([]), { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        input.click();
    });
}

async function selectPlatformDirectory(mode: ExternalDirectoryMode): Promise<FileSystemDirectoryHandle> {
    const picker = (window as Window & typeof globalThis & {
        showDirectoryPicker?: (options: { mode: ExternalDirectoryMode }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (picker == null) {
        throw new Error('folder mounting requires the File System Access API');
    }
    return await picker({ mode });
}

function nativeEntry(file: PlatformFile): ShellFileEntry {
    return {
        path: file.path,
        size: async () => file.size,
        read: () => file.readAsArrayBuffer(),
        drop: async () => {},
    };
}

function formatImportProgress(name: string, copied: number, total?: number): string {
    if (total == null || total <= 0) return `Importing ${name}: ${formatBytes(copied)}`;
    return `Importing ${name}: ${formatBytes(copied)} / ${formatBytes(total)} (${Math.floor(copied / total * 100)}%)`;
}

function formatBytes(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function fileName(path: string): string {
    return path.split(/[\\/]/).pop() || 'file';
}
