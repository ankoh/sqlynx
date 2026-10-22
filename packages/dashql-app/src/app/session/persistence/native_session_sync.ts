import type { Logger } from '../../../platform/logger/logger.js';
import type { SessionLocation } from './session_locator.js';
import {
    StorageBackendType,
    STORAGE_ATTACHMENTS_FOLDER,
    STORAGE_SCRIPTS_FOLDER,
    STORAGE_CATALOG_FUNCTIONS,
    STORAGE_CATALOG_RELATIONS,
} from './storage_backend.js';

const LOG_CTX = 'native_session_sync';
const WATCH_DEBOUNCE_MS = 200;

export interface NativeSessionWatch {
    sessionId: string;
    dir: string;
}

export type NativeSessionChanged = (sessionId: string) => void;
export interface WatchEvent { type?: unknown; paths: string[]; attrs?: unknown; }

export function nativeSessionWatchForLocation(sessionId: string, location: SessionLocation): NativeSessionWatch | null {
    if (location.type !== StorageBackendType.Native || !location.nativePath) {
        return null;
    }
    return { sessionId, dir: location.nativePath };
}

/// True when a watcher event can affect session scripts or attachments. The session manifest and generated
/// cache are intentionally outside this boundary; connection identity/config changes require a full
/// connection lifecycle rather than an in-place file reload.
export function isSessionContentWatchEvent(event: WatchEvent, dir: string): boolean {
    if (event.type != null && typeof event.type === 'object' && 'access' in event.type) {
        return false;
    }
    const normalizedDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
    return event.paths.some(rawPath => {
        const path = rawPath.replace(/\\/g, '/');
        const relative = path === normalizedDir ? '' : path.slice(normalizedDir.length + 1);
        return relative === STORAGE_CATALOG_RELATIONS
            || relative === STORAGE_CATALOG_FUNCTIONS
            || relative === STORAGE_SCRIPTS_FOLDER
            || relative.startsWith(`${STORAGE_SCRIPTS_FOLDER}/`)
            || relative === STORAGE_ATTACHMENTS_FOLDER
            || relative.startsWith(`${STORAGE_ATTACHMENTS_FOLDER}/`);
    });
}

/// Owns all native filesystem watcher lifecycle. The rest of the application sees only a session-id
/// invalidation, keeping platform events and path normalization out of app state code.
export class NativeSessionSyncService {
    private readonly logger: Logger;
    private readonly onChanged: NativeSessionChanged;
    private watches = new Map<string, { dir: string; unwatch: () => Promise<void> }>();
    private generation = 0;

    constructor(logger: Logger, onChanged: NativeSessionChanged) {
        this.logger = logger;
        this.onChanged = onChanged;
    }

    public async reconcile(sessions: NativeSessionWatch[]): Promise<void> {
        const generation = ++this.generation;
        const desired = new Map(sessions.map(session => [session.sessionId, session.dir]));

        for (const [sessionId, current] of this.watches) {
            if (desired.get(sessionId) === current.dir) {
                continue;
            }
            void current.unwatch();
            this.watches.delete(sessionId);
        }

        for (const [sessionId, dir] of desired) {
            if (generation !== this.generation || this.watches.has(sessionId)) {
                continue;
            }
            try {
                const unwatch = await globalThis.dashqlElectron!.watchDirectory(dir, paths => {
                    const event: WatchEvent = {paths};
                    if (isSessionContentWatchEvent(event, dir)) {
                        this.onChanged(sessionId);
                    }
                });
                if (generation !== this.generation || desired.get(sessionId) !== dir) {
                    void unwatch();
                    continue;
                }
                this.watches.set(sessionId, { dir, unwatch });
            } catch (error) {
                this.logger.warn('failed to watch native session', {
                    sessionId,
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
