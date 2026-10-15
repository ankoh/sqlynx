import type { Logger } from '../../../platform/logger/logger.js';
import type { NotebookLocation } from './notebook_locator.js';
import {
    StorageBackendType,
    STORAGE_ATTACHMENTS_FOLDER,
    STORAGE_SCRIPTS_FOLDER,
    STORAGE_SCRIPT_FUNCTIONS,
    STORAGE_SCRIPT_SCHEMA,
} from './storage_backend.js';

const LOG_CTX = 'native_notebook_sync';
const WATCH_DEBOUNCE_MS = 200;

export interface NativeNotebookWatch {
    notebookId: string;
    dir: string;
}

export type NativeNotebookChanged = (notebookId: string) => void;
export interface WatchEvent { type?: unknown; paths: string[]; attrs?: unknown; }

export function nativeNotebookWatchForLocation(notebookId: string, location: NotebookLocation): NativeNotebookWatch | null {
    if (location.type !== StorageBackendType.Native || !location.nativePath) {
        return null;
    }
    return { notebookId, dir: location.nativePath };
}

/// True when a watcher event can affect notebook scripts or attachments. The notebook manifest and generated
/// cache are intentionally outside this boundary; connection identity/config changes require a full
/// connection lifecycle rather than an in-place file reload.
export function isNotebookContentWatchEvent(event: WatchEvent, dir: string): boolean {
    if (event.type != null && typeof event.type === 'object' && 'access' in event.type) {
        return false;
    }
    const normalizedDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
    return event.paths.some(rawPath => {
        const path = rawPath.replace(/\\/g, '/');
        const relative = path === normalizedDir ? '' : path.slice(normalizedDir.length + 1);
        return relative === STORAGE_SCRIPT_SCHEMA
            || relative === STORAGE_SCRIPT_FUNCTIONS
            || relative === STORAGE_SCRIPTS_FOLDER
            || relative.startsWith(`${STORAGE_SCRIPTS_FOLDER}/`)
            || relative === STORAGE_ATTACHMENTS_FOLDER
            || relative.startsWith(`${STORAGE_ATTACHMENTS_FOLDER}/`);
    });
}

/// Owns all native filesystem watcher lifecycle. The rest of the application sees only a notebook-id
/// invalidation, keeping platform events and path normalization out of app state code.
export class NativeNotebookSyncService {
    private readonly logger: Logger;
    private readonly onChanged: NativeNotebookChanged;
    private watches = new Map<string, { dir: string; unwatch: () => Promise<void> }>();
    private generation = 0;

    constructor(logger: Logger, onChanged: NativeNotebookChanged) {
        this.logger = logger;
        this.onChanged = onChanged;
    }

    public async reconcile(notebooks: NativeNotebookWatch[]): Promise<void> {
        const generation = ++this.generation;
        const desired = new Map(notebooks.map(notebook => [notebook.notebookId, notebook.dir]));

        for (const [notebookId, current] of this.watches) {
            if (desired.get(notebookId) === current.dir) {
                continue;
            }
            void current.unwatch();
            this.watches.delete(notebookId);
        }

        for (const [notebookId, dir] of desired) {
            if (generation !== this.generation || this.watches.has(notebookId)) {
                continue;
            }
            try {
                const unwatch = await globalThis.dashqlElectron!.watchDirectory(dir, paths => {
                    const event: WatchEvent = {paths};
                    if (isNotebookContentWatchEvent(event, dir)) {
                        this.onChanged(notebookId);
                    }
                });
                if (generation !== this.generation || desired.get(notebookId) !== dir) {
                    void unwatch();
                    continue;
                }
                this.watches.set(notebookId, { dir, unwatch });
            } catch (error) {
                this.logger.warn('failed to watch native notebook', {
                    notebookId,
                    dir,
                    error: String(error),
                }, LOG_CTX);
            }
        }
    }

    public close(): void {
        this.generation++;
        for (const watch of this.watches.values()) {
            void watch.unwatch();
        }
        this.watches.clear();
    }
}
