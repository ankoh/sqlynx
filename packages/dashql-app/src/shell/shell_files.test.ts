// @vitest-environment node
import type {
    EmbeddedExternalDirectoryDatabase,
    EmbeddedExternalFileDatabase,
    ExternalDirectoryMode,
} from '../platform/database/embedded_database.js';
import type { PlatformFile } from '../platform/file/file.js';
import { LogLevel } from '../platform/logger/log_buffer.js';
import { TestLogger } from '../platform/logger/test_logger.js';
import { createShellFilesCommand, ShellFileRegistry } from './shell_files.js';

function sourceFile(path: string, chunks: number[][], onRead?: () => void): PlatformFile {
    const bytes = chunks.flat();
    return {
        path,
        size: bytes.length,
        blob: new Blob([new Uint8Array(bytes)]),
        stream: () => new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
                controller.close();
            },
        }),
        readAsArrayBuffer: async () => {
            onRead?.();
            return new Uint8Array(bytes);
        },
    };
}

class MockOPFSFileHandle {
    readonly kind = 'file' as const;
    bytes = new Uint8Array();
    closed = false;
    aborted = false;

    async createWritable() {
        const chunks: Uint8Array[] = [];
        return {
            write: async (chunk: Uint8Array) => { chunks.push(chunk.slice()); },
            close: async () => {
                const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
                this.bytes = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                    this.bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                this.closed = true;
            },
            abort: async () => { this.aborted = true; },
        } as FileSystemWritableFileStream;
    }

    async getFile() {
        return { size: this.bytes.byteLength, arrayBuffer: async () => this.bytes.slice().buffer };
    }
}

class MockOPFSDirectoryHandle {
    readonly files = new Map<string, MockOPFSFileHandle>();

    async getDirectoryHandle() {
        return this as unknown as FileSystemDirectoryHandle;
    }

    async getFileHandle(name: string, options?: { create?: boolean }) {
        let file = this.files.get(name);
        if (file == null && !options?.create) throw new DOMException('missing', 'NotFoundError');
        if (file == null) {
            file = new MockOPFSFileHandle();
            this.files.set(name, file);
        }
        return file as unknown as FileSystemFileHandle;
    }

    async removeEntry(name: string) {
        if (!this.files.delete(name)) throw new DOMException('missing', 'NotFoundError');
    }

    async *entries() {
        for (const [name, handle] of this.files) yield [name, handle];
    }
}

class MockExternalFiles implements EmbeddedExternalFileDatabase, EmbeddedExternalDirectoryDatabase {
    readonly files = new Map<string, Blob>();
    nextFile = 1;
    removeError: Error | null = null;
    aborts: string[] = [];
    imports: string[] = [];
    readonly opfsWrites = new Map<string, Uint8Array>();
    readonly directories = new Map<string, ExternalDirectoryMode>();
    nextDirectory = 1;

    constructor(private readonly opfs?: MockOPFSDirectoryHandle) {}

    async registerExternalFile(name: string, blob: Blob): Promise<string> {
        const path = `/mnt/external/${this.nextFile++}/${name}`;
        this.files.set(path, blob);
        return path;
    }

    async removeExternalFile(path: string): Promise<void> {
        if (this.removeError) throw this.removeError;
        if (!this.files.delete(path)) throw new Error(`missing external file: ${path}`);
    }

    async registerExternalDirectory(handle: FileSystemDirectoryHandle, mode: ExternalDirectoryMode): Promise<string> {
        const path = `/mnt/external/directory-${this.nextDirectory++}/${handle.name}`;
        this.directories.set(path, mode);
        return path;
    }

    async removeExternalDirectory(path: string): Promise<void> {
        if (!this.directories.delete(path)) throw new Error(`missing directory: ${path}`);
    }

    async importOPFSFile(
        path: string,
        blob: Blob,
        options?: { signal?: AbortSignal; onProgress?: (bytesWritten: number) => void },
    ): Promise<void> {
        if (options?.signal?.aborted) throw options.signal.reason;
        this.imports.push(path);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        options?.onProgress?.(bytes.byteLength);
        const handle = await this.opfs?.getFileHandle(path.split('/').pop()!, { create: true }) as MockOPFSFileHandle | undefined;
        if (handle != null) {
            handle.bytes = bytes;
            handle.closed = true;
        }
    }

    async prepareOPFSFile(path: string): Promise<void> {
        this.opfsWrites.set(path, new Uint8Array());
    }

    async writeOPFSFile(path: string, chunk: Uint8Array, offset: number): Promise<void> {
        const current = this.opfsWrites.get(path);
        if (current == null) throw new Error(`missing OPFS write: ${path}`);
        const bytes = new Uint8Array(Math.max(current.byteLength, offset + chunk.byteLength));
        bytes.set(current);
        bytes.set(chunk, offset);
        this.opfsWrites.set(path, bytes);
    }

    async finishOPFSFile(path: string): Promise<void> {
        const bytes = this.opfsWrites.get(path);
        if (bytes == null) throw new Error(`missing OPFS write: ${path}`);
        const handle = await this.opfs?.getFileHandle(path.split('/').pop()!, { create: true }) as MockOPFSFileHandle | undefined;
        if (handle != null) {
            handle.bytes = new Uint8Array(bytes);
            handle.closed = true;
        }
        this.opfsWrites.delete(path);
    }

    async abortOPFSFile(path: string): Promise<void> {
        this.aborts.push(path);
        this.opfsWrites.delete(path);
    }

    async removeOPFSFile(path: string): Promise<void> {
        await this.opfs?.removeEntry(path.split('/').pop()!);
    }
}

describe('shell files command', () => {
    it('streams browser files to HyperDB-visible OPFS paths', async () => {
        const opfs = new MockOPFSDirectoryHandle();
        const logger = new TestLogger();
        let sourceReads = 0;
        const registry = new ShellFileRegistry(false, async () => opfs as unknown as FileSystemDirectoryHandle, logger);
        const downloader = { downloadBufferAsFile: vi.fn().mockResolvedValue(undefined) };
        const command = createShellFilesCommand(
            registry,
            downloader,
            async () => [sourceFile('input/data.csv', [[1], [2, 3]], () => { sourceReads++; })],
            logger,
        );

        expect(await command[2](['import'], {})).toBe('Imported 1 file\r\n/mnt/opfs/imported/data.csv');
        expect(opfs.files.get('data.csv')?.bytes).toEqual(new Uint8Array([1, 2, 3]));
        expect(opfs.files.get('data.csv')?.closed).toBe(true);
        expect(sourceReads).toBe(0);
        expect(await command[2](['list'], {})).toBe('/mnt/opfs/imported/data.csv (3 B)');

        expect(await command[2](['get', '/mnt/opfs/imported/data.csv'], {}))
            .toBe('Downloaded /mnt/opfs/imported/data.csv');
        expect(downloader.downloadBufferAsFile).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'data.csv');
        const records = Array.from({ length: logger.buffer.length }, (_, index) => logger.buffer.at(index));
        expect(records.find(record => record?.message === 'Imported shell file to OPFS')?.keyValues).toMatchObject({
            target_path: '/mnt/opfs/imported/data.csv',
            bytes_copied: '3',
            stage: 'complete',
        });

        expect(await command[2](['drop', '/mnt/opfs/imported/data.csv'], {}))
            .toBe('Dropped /mnt/opfs/imported/data.csv');
        expect(opfs.files.has('data.csv')).toBe(false);
    });

    it('keeps add as an import alias', async () => {
        const opfs = new MockOPFSDirectoryHandle();
        const command = createShellFilesCommand(
            new ShellFileRegistry(false, async () => opfs as unknown as FileSystemDirectoryHandle),
            { downloadBufferAsFile: vi.fn() },
            async () => [sourceFile('data.csv', [[1]])],
        );

        expect(await command[2](['add'], {})).toBe('Added 1 file\r\n/mnt/opfs/imported/data.csv');
    });

    it('mounts browser files without reading or streaming them', async () => {
        const opfs = new MockOPFSDirectoryHandle();
        const external = new MockExternalFiles(opfs);
        let sourceReads = 0;
        const file = sourceFile('input/data.csv', [new Array(1536).fill(1)], () => { sourceReads++; });
        const stream = vi.spyOn(file, 'stream');
        const registry = new ShellFileRegistry(
            false,
            async () => opfs as unknown as FileSystemDirectoryHandle,
            undefined,
            external,
        );
        const command = createShellFilesCommand(registry, { downloadBufferAsFile: vi.fn() }, async () => [file]);

        expect(await command[2](['mount'], {})).toBe('/mnt/external/1/data.csv');
        expect(sourceReads).toBe(0);
        expect(stream).not.toHaveBeenCalled();
        expect(opfs.files.size).toBe(0);
        expect(await command[2](['list'], {})).toBe('/mnt/external/1/data.csv (1.5 KiB)');

        expect(await command[2](['drop', '/mnt/external/1/data.csv'], {})).toBe('Dropped /mnt/external/1/data.csv');
        expect(external.files.size).toBe(0);
    });

    it('mounts read-only and read/write browser directories', async () => {
        const external = new MockExternalFiles();
        const registry = new ShellFileRegistry(
            false,
            async () => new MockOPFSDirectoryHandle() as unknown as FileSystemDirectoryHandle,
            undefined,
            external,
            external,
        );
        const directory = { kind: 'directory', name: 'exports' } as FileSystemDirectoryHandle;
        const selectDirectory = vi.fn().mockResolvedValue(directory);
        const command = createShellFilesCommand(
            registry,
            { downloadBufferAsFile: vi.fn() },
            undefined,
            undefined,
            selectDirectory,
        );

        expect(await command[2](['mount-dir'], {})).toBe('/mnt/external/directory-1/exports');
        expect(await command[2](['mount-dir-rw'], {})).toBe('/mnt/external/directory-2/exports');
        expect(selectDirectory).toHaveBeenNthCalledWith(1, 'read');
        expect(selectDirectory).toHaveBeenNthCalledWith(2, 'readwrite');
        expect(await command[2](['list'], {})).toBe([
            '/mnt/external/directory-1/exports (directory, read-only)',
            '/mnt/external/directory-2/exports (directory, read/write)',
        ].join('\r\n'));

        expect(await command[2](['drop', '/mnt/external/directory-2/exports'], {}))
            .toBe('Dropped /mnt/external/directory-2/exports');
        expect(external.directories.has('/mnt/external/directory-2/exports')).toBe(false);
        await registry.dispose();
        expect(external.directories.size).toBe(0);
    });

    it('imports browser Blobs without reading their page-side streams', async () => {
        const opfs = new MockOPFSDirectoryHandle();
        const external = new MockExternalFiles(opfs);
        const file = sourceFile('input/data.csv', [[1, 2, 3]]);
        const stream = vi.spyOn(file, 'stream');
        const progress = vi.fn();
        const registry = new ShellFileRegistry(
            false,
            async () => opfs as unknown as FileSystemDirectoryHandle,
            undefined,
            external,
        );

        await expect(registry.importFile(file, { onProgress: progress }))
            .resolves.toBe('/mnt/opfs/imported/data.csv');

        expect(stream).not.toHaveBeenCalled();
        expect(external.imports).toEqual(['/mnt/opfs/imported/data.csv']);
        expect(opfs.files.get('data.csv')?.bytes).toEqual(new Uint8Array([1, 2, 3]));
        expect(progress).toHaveBeenLastCalledWith('Importing data.csv: 3 B / 3 B (100%)');
    });

    it('retains mounted files when HyperDB reports active readers', async () => {
        const external = new MockExternalFiles();
        const registry = new ShellFileRegistry(false, async () => new MockOPFSDirectoryHandle() as unknown as FileSystemDirectoryHandle, undefined, external);
        const path = await registry.mountFile(sourceFile('data.csv', [[1]]));
        external.removeError = new Error('External file has active readers');

        await expect(registry.drop(path)).rejects.toThrow('External file has active readers');
        expect(await registry.list()).toContain(path);
    });

    it('aborts an import without committing a partial file', async () => {
        const opfs = new MockOPFSDirectoryHandle();
        const logger = new TestLogger();
        const controller = new AbortController();
        const file: PlatformFile = {
            path: 'lineitem.parquet',
            size: 2_215_087_263,
            stream: () => new ReadableStream({
                start(stream) {
                    stream.enqueue(new Uint8Array([1, 2, 3]));
                    controller.abort(new DOMException('cancelled', 'AbortError'));
                },
            }),
            readAsArrayBuffer: async () => { throw new Error('must not materialize'); },
        };
        const registry = new ShellFileRegistry(false, async () => opfs as unknown as FileSystemDirectoryHandle, logger);

        await expect(registry.importFile(file, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(opfs.files.has('lineitem.parquet')).toBe(false);
        const record = Array.from({ length: logger.buffer.length }, (_, index) => logger.buffer.at(index))
            .find(candidate => candidate?.message === 'Failed to import shell file to OPFS');
        expect(record).toMatchObject({
            level: LogLevel.Error,
            target: 'standalone_shell_files',
            keyValues: {
                source_path: 'lineitem.parquet',
                size_bytes: '2215087263',
                stage: 'stream_opfs_file',
                error_name: 'AbortError',
            },
        });
    });

    it('preserves an existing OPFS file when replacement fails', async () => {
        const opfs = new MockOPFSDirectoryHandle();
        const existing = await opfs.getFileHandle('data.csv', { create: true }) as unknown as MockOPFSFileHandle;
        existing.bytes = new Uint8Array([9]);
        const registry = new ShellFileRegistry(false, async () => opfs as unknown as FileSystemDirectoryHandle);
        const failure = new Error('source failed');
        const file: PlatformFile = {
            path: 'data.csv',
            size: 10,
            stream: () => new ReadableStream({ start: controller => controller.error(failure) }),
            readAsArrayBuffer: async () => new Uint8Array(),
        };

        await expect(registry.importFile(file)).rejects.toBe(failure);
        expect(existing.bytes).toEqual(new Uint8Array([9]));
        expect(existing.aborted).toBe(true);
    });

    it('aborts a worker-side import without deleting an existing destination', async () => {
        const opfs = new MockOPFSDirectoryHandle();
        const existing = await opfs.getFileHandle('data.csv', { create: true }) as unknown as MockOPFSFileHandle;
        existing.bytes = new Uint8Array([9]);
        const external = new MockExternalFiles(opfs);
        const failure = new Error('source failed');
        const registry = new ShellFileRegistry(
            false,
            async () => opfs as unknown as FileSystemDirectoryHandle,
            undefined,
            external,
        );

        await expect(registry.importFile({
            path: 'data.csv',
            size: 10,
            stream: () => new ReadableStream({ start: controller => controller.error(failure) }),
            readAsArrayBuffer: async () => new Uint8Array(),
        })).rejects.toBe(failure);

        expect(external.aborts).toEqual(['/mnt/opfs/imported/data.csv']);
        expect(existing.bytes).toEqual(new Uint8Array([9]));
    });

    it('lists and gets OPFS files created before the registry', async () => {
        const opfs = new MockOPFSDirectoryHandle();
        const existing = await opfs.getFileHandle('existing.csv', { create: true }) as unknown as MockOPFSFileHandle;
        existing.bytes = new Uint8Array([7, 8]);
        const downloader = { downloadBufferAsFile: vi.fn().mockResolvedValue(undefined) };
        const command = createShellFilesCommand(
            new ShellFileRegistry(false, async () => opfs as unknown as FileSystemDirectoryHandle),
            downloader,
        );

        expect(await command[2](['list'], {})).toBe('/mnt/opfs/imported/existing.csv (2 B)');
        expect(await command[2](['get', '/opfs/imported/existing.csv'], {}))
            .toBe('Downloaded /opfs/imported/existing.csv');
    });

    it('accepts legacy OPFS paths for current-session imports', async () => {
        const opfs = new MockOPFSDirectoryHandle();
        const external = new MockExternalFiles(opfs);
        const registry = new ShellFileRegistry(
            false,
            async () => opfs as unknown as FileSystemDirectoryHandle,
            undefined,
            external,
        );
        await registry.importFile(sourceFile('data.csv', [[1, 2, 3]]));

        expect(await registry.get('/opfs/imported/data.csv')).toBeDefined();
        expect(await registry.drop('/opfs/imported/data.csv')).toBe(true);
        expect(await registry.list()).toEqual([]);
    });

    it('disposes mounts without deleting imports', async () => {
        const opfs = new MockOPFSDirectoryHandle();
        const external = new MockExternalFiles(opfs);
        const registry = new ShellFileRegistry(false, async () => opfs as unknown as FileSystemDirectoryHandle, undefined, external);
        const imported = await registry.importFile(sourceFile('imported.csv', [[1]]));
        const mounted = await registry.mountFile(sourceFile('mounted.csv', [[2]]));

        await registry.dispose();
        await registry.dispose();

        expect(external.files.has(mounted)).toBe(false);
        expect(opfs.files.has('imported.csv')).toBe(true);
        expect(await registry.list()).toEqual([imported]);
    });

    it('keeps native files at their host paths without deleting them', async () => {
        const registry = new ShellFileRegistry(true);
        const downloader = { downloadBufferAsFile: vi.fn().mockResolvedValue(undefined) };
        const command = createShellFilesCommand(
            registry,
            downloader,
            async () => [sourceFile('/tmp/a file.csv', [[4, 5]])],
        );

        expect(await command[2](['add'], {})).toBe('Added 1 file\r\n/tmp/a file.csv');
        expect(await command[2](['get', '/tmp/a', 'file.csv'], {})).toBe('Downloaded /tmp/a file.csv');
        expect(await command[2](['drop', '/tmp/a', 'file.csv'], {})).toBe('Dropped /tmp/a file.csv');
    });

    it('validates subcommands and registered paths', async () => {
        const command = createShellFilesCommand(
            new ShellFileRegistry(true),
            { downloadBufferAsFile: vi.fn() },
            async () => [],
        );

        await expect(command[2](['add'], {})).resolves.toBe('No files selected');
        await expect(command[2](['unknown'], {})).rejects.toThrow('usage: .fs [list|mount|mount-dir|mount-dir-rw|import|add|drop|get]');
        await expect(command[2](['get', 'missing.csv'], {})).rejects.toThrow('file not registered: missing.csv');
        await expect(command[2](['drop'], {})).rejects.toThrow('usage: .fs drop <path>');
    });
});
