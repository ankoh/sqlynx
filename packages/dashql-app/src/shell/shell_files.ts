import type {
    EmbeddedExternalDirectoryDatabase,
    EmbeddedExternalFileDatabase,
    ExternalDirectoryMode,
} from '../platform/database/embedded_database.js';
import type { PlatformFile } from '../platform/file/file.js';
import { stringifyError, type LoggerLike } from '../platform/logger/logger.js';
import type { DashQLShellCommand, DashQLShellCommandContext } from './api.js';

const LOG_CTX = 'standalone_shell_files';
const FS_USAGE = 'usage: .fs';

interface ShellFileEntry {
    readonly path: string;
    size(): Promise<number | undefined>;
    drop(): Promise<void>;
}

export interface ShellFileListing {
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
        private readonly logger?: LoggerLike,
        private readonly externalFiles?: EmbeddedExternalFileDatabase,
        private readonly externalDirectories?: EmbeddedExternalDirectoryDatabase,
    ) {}

    async list(): Promise<readonly string[]> {
        return (await this.listFiles()).map(file => file.path);
    }

    async listFiles(): Promise<readonly ShellFileListing[]> {
        const files: ShellFileListing[] = [];
        for (const path of this.mountedPaths) {
            files.push({ path, size: await this.files.get(path)?.size() });
        }
        for (const [path, directoryMode] of this.directories) {
            files.push({ path, directoryMode });
        }
        return files.sort((a, b) => a.path.localeCompare(b.path));
    }

    async mountFile(file: PlatformFile, path?: string, options: FileOperationOptions = {}): Promise<string> {
        this.checkUsable();
        if (this.externalFiles == null) throw new Error('external browser files are not supported');
        if (file.blob == null) throw new Error(`file cannot be mounted directly: ${file.path}`);
        throwIfAborted(options.signal);

        const startedAt = Date.now();
        const name = fileName(file.path);
        this.logger?.info('Mounting shell file', logDetails(file.path, undefined, file.size, 'register_external_file', startedAt), LOG_CTX);
        let mountedPath: string | null = null;
        try {
            options.onProgress?.(`Mounting ${name}`);
            mountedPath = await this.externalFiles.registerExternalFile(name, file.blob, path, options.signal);
            if (this.disposed || options.signal?.aborted) {
                await this.externalFiles.removeExternalFile(mountedPath);
                throw options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
            }
            const entry: ShellFileEntry = {
                path: mountedPath,
                size: async () => file.size ?? file.blob!.size,
                drop: () => this.externalFiles!.removeExternalFile(mountedPath!),
            };
            this.files.set(mountedPath, entry);
            this.mountedPaths.add(mountedPath);
            this.logger?.info('Mounted shell file', logDetails(file.path, mountedPath, file.size, 'complete', startedAt), LOG_CTX);
            return mountedPath;
        } catch (error) {
            this.logger?.error('Failed to mount shell file', {
                ...logDetails(file.path, mountedPath ?? undefined, file.size, 'register_external_file', startedAt),
                error: stringifyError(error),
                error_name: error instanceof Error ? error.name : undefined,
            }, LOG_CTX);
            throw error;
        }
    }

    async mountDirectory(
        handle: FileSystemDirectoryHandle,
        path: string | undefined,
        mode: ExternalDirectoryMode,
    ): Promise<string> {
        this.checkUsable();
        if (this.externalDirectories == null) throw new Error('external browser directories are not supported');
        const startedAt = Date.now();
        this.logger?.info('Mounting shell directory', logDetails(handle.name, undefined, undefined, 'register_external_directory', startedAt), LOG_CTX);
        let mountedPath: string | null = null;
        try {
            mountedPath = await this.externalDirectories.registerExternalDirectory(handle, path, mode);
            if (this.disposed) {
                await this.externalDirectories.removeExternalDirectory(mountedPath);
                throw new Error('shell file registry is disposed');
            }
            this.directories.set(mountedPath, mode);
            this.logger?.info('Mounted shell directory', {
                ...logDetails(handle.name, mountedPath, undefined, 'complete', startedAt),
                mode,
            }, LOG_CTX);
            return mountedPath;
        } catch (error) {
            this.logger?.error('Failed to mount shell directory', {
                ...logDetails(handle.name, mountedPath ?? undefined, undefined, 'register_external_directory', startedAt),
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
        const entry = this.files.get(path);
        if (entry != null) {
            await entry.drop();
            this.files.delete(path);
            this.mountedPaths.delete(path);
            return true;
        }
        return false;
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

    private checkUsable(): void {
        if (this.disposed) throw new Error('shell file registry is disposed');
    }
}

export function createShellFilesCommand(
    registry: ShellFileRegistry,
    requestMountDialog?: (signal?: AbortSignal) => Promise<string>,
    requestFilesystemDialog?: (signal?: AbortSignal) => Promise<void>,
): DashQLShellCommand {
    return [
        'fs',
        'Manage filesystem mounts',
        async (args, context) => {
            if (args.length === 0 || args[0] === 'ls') {
                if (args.length > 1) return FS_USAGE;
                if (requestFilesystemDialog == null) return FS_USAGE;
                await requestFilesystemDialog(context.signal);
                return;
            }
            if (args[0] === 'mount' || args[0] === 'mount-dir' || args[0] === 'mount-dir-rw') {
                if (args.length > 1 || requestMountDialog == null) return FS_USAGE;
                const path = await requestMountDialog(context.signal);
                return path === 'Mount cancelled' ? undefined : path;
            }
            return FS_USAGE;
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

export async function selectPlatformFiles(signal?: AbortSignal): Promise<readonly PlatformFile[]> {
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

export async function selectPlatformDirectory(mode: ExternalDirectoryMode): Promise<FileSystemDirectoryHandle> {
    const picker = (window as Window & typeof globalThis & {
        showDirectoryPicker?: (options: { mode: ExternalDirectoryMode }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (picker == null) {
        throw new Error('folder mounting requires the File System Access API');
    }
    return await picker({ mode });
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function fileName(path: string): string {
    return path.split(/[\\/]/).pop() || 'file';
}
