// Keep OPFS mutation in the engine realm so WasmFS and the browser observe the same handles.
const openFiles = new Map();
self.addEventListener('message', event => {
    if (!event.data?.type?.startsWith('dashql:') || !event.data.type.endsWith('-opfs-file')) return;
    if (event.data.type === 'dashql:import-opfs-file') {
        void importOPFSFile(event.data.path, event.data.blob, event.ports[0]);
        return;
    }
    const port = event.ports[0];
    try {
        if (event.data.type === 'dashql:prepare-opfs-file') {
            if (openFiles.has(event.data.path)) throw new Error('OPFS file is already open');
            const temporaryPath = `${event.data.path}.dashql-import-${crypto.randomUUID()}`;
            openFiles.set(event.data.path, {
                stream: self.Module.FS.open(temporaryPath, 'w'),
                temporaryPath,
                offset: 0,
            });
        } else if (event.data.type === 'dashql:write-opfs-file') {
            const file = openFiles.get(event.data.path);
            if (file == null) throw new Error('OPFS file is not open');
            if (file.offset !== event.data.offset) throw new Error(`OPFS write offset ${event.data.offset} does not match size ${file.offset}`);
            self.Module.FS.write(file.stream, event.data.bytes, 0, event.data.bytes.byteLength);
            file.offset += event.data.bytes.byteLength;
        } else if (event.data.type === 'dashql:finish-opfs-file') {
            const temporaryPath = closeFile(event.data.path);
            if (temporaryPath == null) throw new Error('OPFS file is not open');
            try {
                self.Module.FS.rename(temporaryPath, event.data.path);
            } catch (error) {
                self.Module.FS.unlink(temporaryPath);
                throw error;
            }
        } else if (event.data.type === 'dashql:abort-opfs-file') {
            const temporaryPath = closeFile(event.data.path);
            if (temporaryPath != null) self.Module.FS.unlink(temporaryPath);
        } else if (event.data.type === 'dashql:remove-opfs-file') {
            const temporaryPath = closeFile(event.data.path);
            if (temporaryPath != null) self.Module.FS.unlink(temporaryPath);
            self.Module.FS.unlink(event.data.path);
        } else {
            return;
        }
        port.postMessage({});
    } catch (error) {
        port.postMessage({ error: `${event.data.type}: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
        port.close();
    }
});

async function importOPFSFile(path, blob, port) {
    let cancelled = false;
    let writable = null;
    let temporaryName = null;
    let temporaryPath = null;
    const onCancel = event => { cancelled ||= event.data?.type === 'cancel'; };
    port.addEventListener('message', onCancel);
    port.start();
    try {
        const target = await resolveOPFSFile(path);
        temporaryName = `${target.name}.dashql-import-${crypto.randomUUID()}`;
        temporaryPath = `${target.directoryPath}/${temporaryName}`;
        const temporaryHandle = await target.directory.getFileHandle(temporaryName, { create: true });
        writable = await temporaryHandle.createWritable();
        const chunkSize = 16 * 1024 * 1024;
        let bytesWritten = 0;
        while (bytesWritten < blob.size) {
            throwIfCancelled(cancelled);
            const chunk = blob.slice(bytesWritten, Math.min(bytesWritten + chunkSize, blob.size));
            await writable.write(chunk);
            bytesWritten += chunk.size;
            port.postMessage({ type: 'progress', bytesWritten });
        }
        throwIfCancelled(cancelled);
        await writable.close();
        writable = null;

        // Resolve the completed entry through WasmFS before atomically replacing the destination.
        self.Module.FS.stat(temporaryPath);
        self.Module.FS.rename(temporaryPath, path);
        temporaryName = null;
        temporaryPath = null;
        port.postMessage({ type: 'done' });
    } catch (error) {
        if (writable != null) {
            try { await writable.abort(error); } catch {}
        }
        if (temporaryPath != null) {
            try { self.Module.FS.unlink(temporaryPath); } catch {}
        }
        if (temporaryName != null) {
            try {
                const target = await resolveOPFSFile(path);
                await target.directory.removeEntry(temporaryName);
            } catch {}
        }
        port.postMessage({
            type: 'error',
            name: error instanceof Error ? error.name : undefined,
            error: error instanceof Error ? error.message : String(error),
        });
    } finally {
        port.removeEventListener('message', onCancel);
        port.close();
    }
}

async function resolveOPFSFile(path) {
    const root = path.startsWith('/mnt/fs/') ? '/mnt/fs' : null;
    if (root == null) throw new Error(`Invalid OPFS path: ${path}`);
    const parts = path.slice(root.length + 1).split('/');
    if (parts.length < 1 || parts.some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid OPFS path: ${path}`);
    }
    const name = parts.pop();
    let directory = await navigator.storage.getDirectory();
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: false });
    return {
        directory,
        directoryPath: `${root}/${parts.join('/')}`,
        name,
    };
}

function throwIfCancelled(cancelled) {
    if (cancelled) throw new DOMException('The operation was aborted', 'AbortError');
}

function closeFile(path) {
    const file = openFiles.get(path);
    if (file == null) return null;
    try {
        self.Module.FS.close(file.stream);
    } finally {
        openFiles.delete(path);
    }
    return file.temporaryPath;
}

const workerUrl = new URL(self.location.href).searchParams.get('workerUrl');
if (workerUrl == null) throw new Error('Missing HyperDB worker URL');
self.importScripts(workerUrl);
