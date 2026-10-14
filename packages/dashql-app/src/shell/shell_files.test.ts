// @vitest-environment node
import type {
    EmbeddedExternalDirectoryDatabase,
    EmbeddedExternalFileDatabase,
    ExternalDirectoryMode,
} from '../platform/database/embedded_database.js';
import type { PlatformFile } from '../platform/file/file.js';
import { createShellFilesCommand, ShellFileRegistry } from './shell_files.js';

function sourceFile(path: string): PlatformFile {
    return {
        path,
        size: 3,
        blob: new Blob([new Uint8Array([1, 2, 3])]),
        stream: () => new ReadableStream(),
        readAsArrayBuffer: async () => new Uint8Array([1, 2, 3]),
    };
}

class MockExternalFiles implements EmbeddedExternalFileDatabase, EmbeddedExternalDirectoryDatabase {
    readonly files = new Map<string, Blob>();
    readonly directories = new Map<string, ExternalDirectoryMode>();

    async registerExternalFile(name: string, blob: Blob): Promise<string> {
        const path = `/mnt/external/${name}`;
        this.files.set(path, blob);
        return path;
    }

    async removeExternalFile(path: string): Promise<void> {
        if (!this.files.delete(path)) throw new Error(`missing external file: ${path}`);
    }

    async registerExternalDirectory(
        handle: FileSystemDirectoryHandle,
        path: string | undefined,
        mode: ExternalDirectoryMode,
    ): Promise<string> {
        path ??= `/mnt/external/${handle.name}`;
        this.directories.set(path, mode);
        return path;
    }

    async removeExternalDirectory(path: string): Promise<void> {
        if (!this.directories.delete(path)) throw new Error(`missing directory: ${path}`);
    }
}

describe('shell files command', () => {
    it('mounts browser files without reading or streaming them', async () => {
        const external = new MockExternalFiles();
        const file = sourceFile('input/data.csv');
        const stream = vi.spyOn(file, 'stream');
        const registry = new ShellFileRegistry(undefined, external);

        expect(await registry.mountFile(file)).toBe('/mnt/external/data.csv');
        expect(stream).not.toHaveBeenCalled();
        expect(await registry.list()).toEqual(['/mnt/external/data.csv']);
    });

    it('rejects retired and unknown subcommands', async () => {
        const command = createShellFilesCommand(new ShellFileRegistry());

        for (const action of ['add', 'import', 'list', 'mount-dir', 'mount-dir-rw', 'drop', 'get', 'unknown']) {
            await expect(command[2]([action], {})).resolves.toBe('usage: .fs');
        }
    });

    it('opens the filesystem dialog without a subcommand', async () => {
        const requestFilesystemDialog = vi.fn().mockResolvedValue(undefined);
        const requestMountDialog = vi.fn().mockResolvedValue('/mnt/external/data.csv');
        const command = createShellFilesCommand(
            new ShellFileRegistry(),
            requestMountDialog,
            requestFilesystemDialog,
        );

        await expect(command[2]([], {})).resolves.toBeUndefined();
        await expect(command[2](['ls'], {})).resolves.toBeUndefined();
        await expect(command[2](['mount'], {})).resolves.toBe('/mnt/external/data.csv');
        expect(requestFilesystemDialog).toHaveBeenCalledWith(undefined);
        expect(requestFilesystemDialog).toHaveBeenCalledTimes(2);
        expect(requestMountDialog).toHaveBeenCalledWith(undefined);
    });

    it('does not print mount cancellation', async () => {
        const command = createShellFilesCommand(
            new ShellFileRegistry(),
            async () => 'Mount cancelled',
        );

        await expect(command[2](['mount'], {})).resolves.toBeUndefined();
    });
});
