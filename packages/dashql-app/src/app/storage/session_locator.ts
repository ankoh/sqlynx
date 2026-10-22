import { StorageBackendType, STORAGE_SESSIONS_FOLDER, type SessionEntry } from './storage_backend.js';

/// Where a single session's files live.
///
/// The session UUID is the authoritative identity; this describes the *physical* location of that
/// session's files. `nativePath` is the absolute directory that directly holds the session's files
/// (one directory == one session) and is only set when `type` is `Native`.
export interface SessionLocation {
    /// The storage backend that physically holds this session's files
    type: StorageBackendType;
    /// The absolute directory holding the session's files (only for native sessions)
    nativePath?: string;
}

/// Derive a session's physical location from its manifest entry.
///
/// A `native` entry must carry a `nativePath`; anything else (including the common case of an entry
/// with no storageType field at all) is treated as living in the OPFS root.
export function locationFromEntry(entry: SessionEntry): SessionLocation {
    if (entry.storageType === StorageBackendType.Native && entry.nativePath) {
        return { type: StorageBackendType.Native, nativePath: entry.nativePath };
    }
    return { type: StorageBackendType.OPFS };
}

/// Build the display path for a session.
///
/// This value is purely for display (the session bar, the storage overlay). Nothing parses it for
/// identity or routing — the UUID + `SessionLocation` are the source of truth.
export function displayPath(uuid: string, loc: SessionLocation): string {
    if (loc.type === StorageBackendType.Native && loc.nativePath) {
        return `fs://${loc.nativePath}`;
    }
    return `opfs://${STORAGE_SESSIONS_FOLDER}/${uuid}`;
}
