import * as Immutable from 'immutable';
import * as dashql from '@ankoh/dashql-core';

import { Logger, stringifyError } from '../../platform/logger/logger.js';
import { VariantKind } from '../../utils/variant.js';
import type { StorageBackend, SessionData, SessionMetadata as StorageSessionMetadata, SessionSettings, SessionConnection, ConnectionEntry, ConnectionParams, SessionRegistryBackend, SessionScript } from './storage_backend.js';
import { STORAGE_SCRIPTS_FOLDER, STORAGE_SESSION_FILE, STORAGE_CATALOG_RELATIONS, STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_CHANGES, STORAGE_CONNECTIONS_FOLDER, isSessionRegistryBackend } from './storage_backend.js';
import { SESSION_FORMAT_VERSION } from '../../migration/versions.js';
import { sessionAttachments, withSessionScripts } from './session_files.js';

const LOG_CTX = 'storage_writer';

/// Order-independent deep equality for plain JSON values (objects, arrays, primitives).
/// Session manifests are plain JSON (no Dates/Maps/functions), so this is sufficient.
function jsonDeepEqual(a: any, b: any): boolean {
    if (a === b) {
        return true;
    }
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
        return false;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }
        return a.every((v, i) => jsonDeepEqual(v, b[i]));
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    return aKeys.every(k => Object.prototype.hasOwnProperty.call(b, k) && jsonDeepEqual(a[k], b[k]));
}

/// Compare the manifest fields the writer owns (formatVersion, sessionId, name, defaultConnectionId, connections, scripts, attachments, metadata).
/// Other fields (storageType/nativePath/sessionPath) are display- or registry-only and are not
/// written into the session file, so they're deliberately ignored.
///
/// Both sides are round-tripped through JSON first so this compares exactly what would be
/// persisted: serialization drops `undefined`-valued keys, so a freshly built params object with
/// `{ foo: undefined }` must compare equal to the reloaded `{}` it serializes to.
function sessionManifestEquals(a: SessionData, b: SessionData): boolean {
    const project = (s: SessionData) => JSON.parse(JSON.stringify({
        formatVersion: s.formatVersion,
        sessionId: s.sessionId,
        name: s.name,
        settings: s.settings,
        defaultConnectionId: s.defaultConnectionId,
        connections: s.connections,
        scripts: s.scripts,
        attachments: s.attachments,
        metadata: s.metadata,
    }));
    return jsonDeepEqual(project(a), project(b));
}

export const DEBOUNCE_DURATION_SESSION_WRITE = 100;
export const DEBOUNCE_DURATION_SCRIPT_WRITE = 100;

export const WRITE_SESSION_MANIFEST = Symbol('WRITE_SESSION_MANIFEST');
export const WRITE_SESSION_PROPERTIES = Symbol('WRITE_SESSION_PROPERTIES');

/// The session fields that are owned by the user, not derived from scripts or connections.
/// They are written together since writes of the same manifest replace each other while debounced.
export interface SessionProperties {
    /// The session name, null if the user never named the session
    name: string | null;
    /// The session settings
    settings: SessionSettings;
}
/// A session that is written as a whole, its scripts first and its manifest last
export interface SessionReplacement {
    /// The session id
    sessionId: string;
    /// The session name, null keeps the name on disk
    name: string | null;
    /// The script files, their text is read when the write runs. The script list of the session file
    /// is written by `WRITE_SESSION_SCRIPTS` alone, it is the only writer of the list.
    scripts: Array<{ fileName: string; readText: () => string }>;
    /// The default connection of a session that is not stored yet
    defaultConnection: SessionConnection;
    /// The file name the session was created from, if any
    originalFileName: string | undefined;
    /// The session settings
    settings: SessionSettings;
}
export const WRITE_SESSION_CATALOG_SCRIPT = Symbol('WRITE_SESSION_CATALOG_SCRIPT');
export const WRITE_SESSION_FUNCTION_SCRIPT = Symbol('WRITE_SESSION_FUNCTION_SCRIPT');
export const WRITE_SESSION_CATALOG_CHANGES = Symbol('WRITE_SESSION_CATALOG_CHANGES');
export const REPLACE_SESSION_SCRIPTS = Symbol('REPLACE_SESSION_SCRIPTS');
export const WRITE_CONNECTION_ENTRY = Symbol('WRITE_CONNECTION_ENTRY');
export const DELETE_CONNECTION_ENTRY = Symbol('DELETE_CONNECTION_ENTRY');
export const WRITE_CONNECTION_FILE = Symbol('WRITE_CONNECTION_FILE');
export const PATCH_SESSION_CONNECTION = Symbol('PATCH_SESSION_CONNECTION');
export const WRITE_SCRIPT = Symbol('WRITE_SCRIPT');
export const DELETE_SESSION = Symbol('DELETE_SESSION');
export const DELETE_SCRIPT = Symbol('DELETE_SCRIPT');
export const RENAME_SCRIPT = Symbol('RENAME_SCRIPT');
export const WRITE_SESSION_SCRIPTS = Symbol('WRITE_SESSION_SCRIPTS');
export const REFRESH_SESSION_ATTACHMENTS = Symbol('REFRESH_SESSION_ATTACHMENTS');

/// The script list of a session
export interface SessionScriptList {
    /// The scripts in feed order with their connections
    scripts: SessionScript[];
    /// Copies of the connections of the scripts that the session file may not hold yet
    connections: SessionConnection[];
}

export type StorageWriteTaskVariant =
    | VariantKind<typeof WRITE_SESSION_MANIFEST, [string, string, SessionConnection[]]>
    | VariantKind<typeof WRITE_SESSION_PROPERTIES, [string, SessionProperties]>
    | VariantKind<typeof WRITE_SESSION_CATALOG_SCRIPT, [string, dashql.DashQLScript]>
    | VariantKind<typeof WRITE_SESSION_FUNCTION_SCRIPT, [string, dashql.DashQLScript]>
    | VariantKind<typeof WRITE_SESSION_CATALOG_CHANGES, [string, string]>
    | VariantKind<typeof REPLACE_SESSION_SCRIPTS, SessionReplacement>
    | VariantKind<typeof WRITE_CONNECTION_ENTRY, ConnectionEntry>
    | VariantKind<typeof DELETE_CONNECTION_ENTRY, string>
    | VariantKind<typeof WRITE_CONNECTION_FILE, [string, string, string]>
    | VariantKind<typeof PATCH_SESSION_CONNECTION, [string, SessionConnection] | [string, SessionConnection, string[]]>
    | VariantKind<typeof WRITE_SCRIPT, [string, string, string]>
    | VariantKind<typeof DELETE_SESSION, string>
    | VariantKind<typeof DELETE_SCRIPT, [string, string]>
    | VariantKind<typeof RENAME_SCRIPT, [string, string, string]>
    | VariantKind<typeof WRITE_SESSION_SCRIPTS, [string, SessionScriptList]>
    | VariantKind<typeof REFRESH_SESSION_ATTACHMENTS, string>
    ;

export type StorageWriteKey = string;
/// The manifest is keyed on its real file path (`<sessionId>/dashql-session.json`) so the key it is
/// *scheduled* under matches the path its *completed* write is recorded under — otherwise the manifest
/// shows up as two rows in the stats view (a phantom `<sessionId>/` schedule row plus the real
/// file's write row). Keying both on the file also means a scheduled-but-not-yet-flushed manifest
/// write coalesces onto the same statistics row as its completion.
export const groupSessionManifestWrites = (sessionId: string) => `${sessionId}/${STORAGE_SESSION_FILE}`;
export const groupSessionSchemaWrites = (sessionId: string) => `${sessionId}/${STORAGE_CATALOG_RELATIONS}`;
export const groupSessionFunctionWrites = (sessionId: string) => `${sessionId}/${STORAGE_CATALOG_FUNCTIONS}`;
export const groupSessionCatalogChangesWrites = (sessionId: string) => `${sessionId}/${STORAGE_CATALOG_CHANGES}`;
export const groupSessionWrites = (sessionId: string) => `${sessionId}/${STORAGE_SCRIPTS_FOLDER}`;
/// The connection entries are written into the app manifest, one key per connection.
export const groupConnectionEntryWrites = (connectionId: string) => `@manifest/${STORAGE_CONNECTIONS_FOLDER}/${connectionId}`;
/// The files of a connection, e.g. its catalog relations
export const groupConnectionFileWrites = (connectionId: string, fileName: string) => `@${STORAGE_CONNECTIONS_FOLDER}/${connectionId}/${fileName}`;
/// The copy of a connection's params in a session. Copies of different connections must not
/// coalesce, but they serialize with every other write of the session.
export const groupSessionConnectionCopyWrites = (sessionId: string, connectionId: string) => `${sessionId}/${STORAGE_SESSION_FILE}:connection/${connectionId}`;
/// The script list of a session and the connections it uses. It is patched into the session file and
/// must not coalesce with the other writes of the session file.
export const groupSessionScriptListWrites = (sessionId: string) => `${sessionId}/${STORAGE_SESSION_FILE}:scripts`;
/// The attachment list of a session
export const groupSessionAttachmentListWrites = (sessionId: string) => `${sessionId}/${STORAGE_SESSION_FILE}:attachments`;
export const groupScriptWrites = (sessionId: string, fileName: string) =>
    `${sessionId}/${STORAGE_SCRIPTS_FOLDER}/${fileName}`;
export const groupScriptDeletes = (sessionId: string, scriptName: string) =>
    `${sessionId}/${STORAGE_SCRIPTS_FOLDER}/${scriptName}:delete`;
/// A page/script rename lives in its own `:rename` keyspace, keyed by the *source* path. Keeping it
/// off the write/delete keyspaces means a later content write (or delete) of the destination never
/// coalesces onto — and so never clobbers — a still-pending rename of the same name. The action lives
/// in a `:rename` *suffix* rather than a prefix so the key still starts with the session id and
/// sorts/scopes like every other file key.
export const groupScriptRenames = (sessionId: string, oldScriptName: string) =>
    `${sessionId}/${STORAGE_SCRIPTS_FOLDER}/${oldScriptName}:rename`;

/// Whether a statistics key belongs to a given session. Every write key is a path rooted at the
/// session id (`<sessionId>/…`), with the `:delete`/`:rename` action namespaces living in a suffix
/// (see the group* helpers above), so the session owns the key when it is the session id itself or a
/// descendant of it. Used to scope the storage-writer stats view to the active session.
export function storageWriteKeyBelongsToSession(key: StorageWriteKey, sessionId: string): boolean {
    return key === sessionId || key.startsWith(`${sessionId}/`);
}

/// Strip the session-id prefix from a write key for display, keeping any `:delete`/`:rename` suffix
/// so the action stays legible. Once the stats view is scoped to a single session the session id is
/// redundant on every row, so e.g. `<sessionId>/scripts/page-1/01.sql` renders as
/// `scripts/page-1/01.sql` and `<sessionId>/scripts/page-1:rename` as `scripts/page-1:rename`.
/// The bare session key collapses to an empty string. Keys that don't belong to the session are
/// returned unchanged.
export function storageWriteKeyWithinSession(key: StorageWriteKey, sessionId: string): string {
    if (!storageWriteKeyBelongsToSession(key, sessionId)) {
        return key;
    }
    return key === sessionId ? '' : key.slice(sessionId.length + 1);
}

/// The outcome of a scheduled write
export type StorageWriteResult =
    /// The task was executed (a task may still skip writing content that is already persisted)
    | { status: 'written' }
    /// A newer task with the same key replaced the task before it was executed
    | { status: 'superseded' }
    /// The task was discarded before it was executed
    | { status: 'cancelled' }
    /// The writer or the session is paused, the task stays pending and is executed on resume
    | { status: 'deferred' }
    /// Executing the task failed
    | { status: 'failed'; error: unknown };

/// The chain key of a write key, tasks with the same chain key are executed one after another.
/// Session keys chain per session (`<sessionId>/…`), so mutations and their index rebuilds cannot
/// overlap. Global keys start with `@` and chain per entity (`@manifest/…`, `@connections/<id>/…`).
export function storageWriteChainKey(key: StorageWriteKey): string {
    const parts = key.split('/');
    if (key.startsWith('@connections/') && parts.length > 1) {
        return `${parts[0]}/${parts[1]}`;
    }
    return parts[0];
}

interface AsyncStorageWriteTask {
    /// The latest task
    latestTask: StorageWriteTaskVariant;
    /// Resolve the caller of the latest task
    resolveLatestTask: (result: StorageWriteResult) => void;
    /// The time when this task was first scheduled
    scheduledAt: Date;
    /// The debounce duration in milliseconds
    debounceDurationMs: number;
    /// The timer
    timer: ReturnType<typeof setTimeout>;
}

export interface StorageWriterStatistics {
    /// The number of writes we scheduled
    totalScheduledWrites: number;
    /// The number of writes we performed
    totalWrites: number;
    /// The number of bytes written in total to storage
    totalWrittenBytes: number;
    /// The accumulated time spent writing
    totalWriteTime: number;
    /// The last write
    lastWrite: Date | null;
}

export type StorageWriteStatisticsMap = Immutable.Map<StorageWriteKey, StorageWriterStatistics>;
export type StorageWriteStatisticsSubscriber = (stats: StorageWriteStatisticsMap) => void;

/// A session whose files are not available, e.g. a native folder that was moved or deleted
export class SessionUnavailableError extends Error {
    /// The session id
    readonly sessionId: string;

    constructor(sessionId: string, cause: unknown) {
        super(`session ${sessionId} is not available: ${stringifyError(cause)}`);
        this.name = 'SessionUnavailableError';
        this.sessionId = sessionId;
    }
}

/// Replace the copies of a connection's params in a session.
/// References of aliases (connections that were consolidated into this one) are rewritten to the
/// connection id. Returns null when the session doesn't reference the connection or the copies are
/// up to date.
export function patchSessionConnection(session: SessionData, copy: SessionConnection, aliases: readonly string[] = []): SessionData | null {
    const connectionId = copy.connectionId;
    const references = (id: string) => id === connectionId || aliases.includes(id);
    const next: SessionData = {
        ...session,
        defaultConnectionId: references(session.defaultConnectionId) ? connectionId : session.defaultConnectionId,
        connections: dedupeConnections(session.connections.map(connection =>
            references(connection.connectionId) ? copy : connection)),
        scripts: session.scripts.map(script => aliases.includes(script.connectionId) ? { ...script, connectionId } : script),
    };
    return sessionManifestEquals(session, next) ? null : next;
}

/// Drop connections that an earlier connection of the list references already.
/// Consolidated connections can turn distinct references into the same one.
export function dedupeConnections<T extends { connectionId: string }>(connections: T[]): T[] {
    const seen = new Set<string>();
    return connections.filter(connection => {
        if (seen.has(connection.connectionId)) return false;
        seen.add(connection.connectionId);
        return true;
    });
}

/// Insert or replace a connection entry, keeping its creation time and aliases
export function upsertConnectionEntry(connections: ConnectionEntry[] | undefined, entry: ConnectionEntry): ConnectionEntry[] | null {
    const entries = connections ?? [];
    const index = entries.findIndex(e => e.id === entry.id);
    const prev = index >= 0 ? entries[index] : null;
    const next: ConnectionEntry = {
        ...entry,
        ...(entry.aliases == null && prev?.aliases != null ? { aliases: prev.aliases } : {}),
        ...(entry.createdAt == null && prev?.createdAt != null ? { createdAt: prev.createdAt } : {}),
    };
    if (prev != null && jsonDeepEqual(JSON.parse(JSON.stringify(prev)), JSON.parse(JSON.stringify(next)))) {
        return null;
    }
    return index >= 0 ? entries.map((e, i) => (i === index ? next : e)) : [...entries, next];
}

export class StorageWriter {
    /// The logger
    logger: Logger;
    /// The storage backend
    backend: StorageBackend;
    /// The pending tasks
    pendingTasks: Map<StorageWriteKey, AsyncStorageWriteTask>;
    /// The statistics
    statistics: StorageWriteStatisticsMap;
    /// The listeners for
    statisticsSubscribers: Set<StorageWriteStatisticsSubscriber>;
    /// Is the writer paused? While paused, debounced timers don't process tasks.
    paused: boolean;
    /// Sessions temporarily held by external reload/conflict handling.
    pausedSessions: Set<string>;
    /// The executions that are currently in flight (used by flush() to await completion).
    inFlight: Set<Promise<void>>;
    /// Latest execution per chain key, so mutations and their index rebuilds cannot overlap.
    chainExecutions: Map<string, Promise<void>>;
    /// Last content known to have been persisted by this writer, keyed by storage-relative path.
    completedFileContents: Map<string, string | null>;
    /// Monotonic scheduled-write generation per key, used to revalidate destructive prompts.
    writeKeyGenerations: Map<string, number>;
    nextWriteGeneration: number;

    constructor(logger: Logger, backend: StorageBackend) {
        this.logger = logger;
        this.backend = backend;
        this.pendingTasks = new Map();
        this.statistics = Immutable.Map();
        this.statisticsSubscribers = new Set();
        this.paused = false;
        this.pausedSessions = new Set();
        this.inFlight = new Set();
        this.chainExecutions = new Map();
        this.completedFileContents = new Map();
        this.writeKeyGenerations = new Map();
        this.nextWriteGeneration = 1;
    }

    /// Pause the writer.
    /// Cancels all pending debounce timers so nothing is written until resume()/flush() is called.
    /// Tasks scheduled while paused stay pending and are re-armed on resume().
    public pause(): void {
        this.paused = true;
        for (const task of this.pendingTasks.values()) {
            clearTimeout(task.timer);
        }
    }

    /// Resume the writer, re-arming debounce timers for any tasks accumulated while paused.
    public resume(): void {
        if (!this.paused) {
            return;
        }
        this.paused = false;
        for (const [key, task] of this.pendingTasks) {
            if ([...this.pausedSessions].some(sessionId => storageWriteKeyBelongsToSession(key, sessionId))) {
                continue;
            }
            task.timer = setTimeout(() => this.processTask(key), task.debounceDurationMs);
        }
    }

    /// Flush the writer: process every pending task immediately and await all in-flight writes.
    /// Works regardless of the paused state and leaves the paused state unchanged.
    public async flush(): Promise<void> {
        const wasPaused = this.paused;
        // Temporarily allow processing even if paused.
        this.paused = false;
        const keys = [...this.pendingTasks.keys()];
        for (const key of keys) {
            const task = this.pendingTasks.get(key);
            if (task) {
                clearTimeout(task.timer);
            }
            await this.processTask(key, true);
        }
        this.paused = wasPaused;
        // Await any executions that were already in flight (e.g. a timer that fired just before).
        while (this.inFlight.size > 0) {
            await Promise.all([...this.inFlight]);
        }
    }

    public getStatistics(): StorageWriteStatisticsMap {
        return this.statistics;
    }

    public pauseSession(sessionId: string): void {
        this.pausedSessions.add(sessionId);
        for (const [key, task] of this.pendingTasks) {
            if (storageWriteKeyBelongsToSession(key, sessionId)) {
                clearTimeout(task.timer);
            }
        }
    }

    public resumeSession(sessionId: string): void {
        if (!this.pausedSessions.delete(sessionId) || this.paused) {
            return;
        }
        for (const [key, task] of this.pendingTasks) {
            if (storageWriteKeyBelongsToSession(key, sessionId)) {
                task.timer = setTimeout(() => this.processTask(key), task.debounceDurationMs);
            }
        }
    }

    /// Pending write keys below a session id. This is intentionally prefix-based: every writer key
    /// is rooted at the session id, including the delete/rename action namespaces.
    public getPendingKeysForSession(sessionId: string, include: (key: string) => boolean = () => true): string[] {
        return [...this.pendingTasks.keys()].filter(key => storageWriteKeyBelongsToSession(key, sessionId) && include(key));
    }

    /// Discard pending writes for a session, resolving their promises as not executed. Used only
    /// after the user explicitly chooses an externally-written disk version over local debounced
    /// edits. Writes already in flight cannot be cancelled and are handled by settle().
    public cancelPendingWritesForSession(sessionId: string, include: (key: string) => boolean = () => true): void {
        for (const [key, task] of this.pendingTasks) {
            if (!storageWriteKeyBelongsToSession(key, sessionId) || !include(key)) {
                continue;
            }
            clearTimeout(task.timer);
            this.pendingTasks.delete(key);
            task.resolveLatestTask({ status: 'cancelled' });
        }
    }

    /// Wait for writes that have already started without flushing pending debounced work.
    public async settle(): Promise<void> {
        while (this.inFlight.size > 0) {
            await Promise.all([...this.inFlight]);
        }
    }

    public getSessionWriteGeneration(sessionId: string, include: (key: string) => boolean = () => true): number {
        let generation = 0;
        for (const [key, value] of this.writeKeyGenerations) {
            if (storageWriteKeyBelongsToSession(key, sessionId) && include(key)) {
                generation = Math.max(generation, value);
            }
        }
        return generation;
    }

    public getCompletedFileContent(path: string): string | null | undefined {
        return this.completedFileContents.get(path);
    }

    public subscribeStatisticsListener(listener: StorageWriteStatisticsSubscriber) {
        this.statisticsSubscribers.add(listener);

    }
    public unsubscribeStatisticsListener(listener: StorageWriteStatisticsSubscriber) {
        this.statisticsSubscribers.delete(listener);
    }

    /// Schedule a debounced write, resolves true when the task was executed.
    /// A newer write with the same key replaces a pending task and resolves its caller with false.
    public async write(key: string, task: StorageWriteTaskVariant, debounceFor: number = 0): Promise<boolean> {
        const result = await this.schedule(key, task, debounceFor);
        return result.status === 'written';
    }

    /// Write without debouncing and wait until the content is persisted.
    ///
    /// The task replaces any pending task with the same key and is executed right away, chained after
    /// running tasks of the same chain key. A paused writer or session resolves with `deferred` and
    /// keeps the task pending, it is executed on resume.
    public writeDurable(key: string, task: StorageWriteTaskVariant): Promise<StorageWriteResult> {
        const result = this.schedule(key, task, 0);
        const pending = this.pendingTasks.get(key)!;
        clearTimeout(pending.timer);
        if (this.isPausedKey(key)) {
            pending.resolveLatestTask({ status: 'deferred' });
            pending.resolveLatestTask = () => { };
        } else {
            void this.processTask(key);
        }
        return result;
    }

    /// Is a key held by a paused writer or a paused session?
    protected isPausedKey(key: string): boolean {
        return this.paused || [...this.pausedSessions].some(sessionId => storageWriteKeyBelongsToSession(key, sessionId));
    }

    protected schedule(key: string, task: StorageWriteTaskVariant, debounceFor: number): Promise<StorageWriteResult> {
        this.writeKeyGenerations.set(key, this.nextWriteGeneration++);
        // Is there a previous task with the same key?
        const prevTask = this.pendingTasks.get(key);
        let scheduledAt: Date;
        let debounceDurationMs: number = debounceFor;
        let timer: ReturnType<typeof setTimeout>;
        if (prevTask) {
            // Tell the former write call that the task was not executed
            prevTask.resolveLatestTask({ status: 'superseded' });
            // Overwrite the task
            scheduledAt = prevTask.scheduledAt;
            debounceDurationMs = prevTask.debounceDurationMs;
            timer = prevTask.timer;
        } else {
            scheduledAt = new Date();
            timer = setTimeout(() => this.processTask(key), debounceFor);
        }
        let resolveTask: ((result: StorageWriteResult) => void) | null = null;
        const result = new Promise<StorageWriteResult>(resolve => { resolveTask = resolve; });

        // Overwrite any previous task with the same key
        this.pendingTasks.set(key, {
            latestTask: task,
            resolveLatestTask: resolveTask!,
            scheduledAt: scheduledAt,
            debounceDurationMs,
            timer,
        });
        this.registerScheduledWrite(key);
        return result;
    }

    protected async processTask(key: string, force: boolean = false) {
        const task = this.pendingTasks.get(key);
        if (!task) {
            return;
        }
        // If a timer fires while paused, leave the task pending - it'll be re-armed on resume().
        if (!force && this.isPausedKey(key)) {
            return;
        }
        this.pendingTasks.delete(key);
        const chainKey = storageWriteChainKey(key);
        const previousExecution = this.chainExecutions.get(chainKey);
        const execution = (async () => {
            if (previousExecution) {
                await previousExecution;
            }
            try {
                await this.executeTask(key, task.latestTask);
                task.resolveLatestTask({ status: 'written' });
            } catch (e: any) {
                this.logger.error("executing write task failed", {
                    key: key,
                    error: stringifyError(e)
                })
                task.resolveLatestTask({ status: 'failed', error: e });
            }
        })();
        this.chainExecutions.set(chainKey, execution);
        this.inFlight.add(execution);
        try {
            await execution;
        } finally {
            this.inFlight.delete(execution);
            if (this.chainExecutions.get(chainKey) === execution) {
                this.chainExecutions.delete(chainKey);
            }
        }
    }

    protected updateStatistics(statistics: Immutable.Map<StorageWriteKey, StorageWriterStatistics>) {
        this.statistics = statistics;
        for (const subscriber of this.statisticsSubscribers) {
            subscriber(statistics);
        }
    }

    protected registerScheduledWrite(key: StorageWriteKey) {
        const ifNotSet: StorageWriterStatistics = {
            totalScheduledWrites: 1,
            totalWrites: 0,
            totalWrittenBytes: 0,
            totalWriteTime: 0,
            lastWrite: null,
        };
        const stats = this.statistics.update(key, ifNotSet, (stats) => ({ ...stats, totalScheduledWrites: stats.totalScheduledWrites + 1 }));
        this.updateStatistics(stats);
    }

    protected registerWrite(key: StorageWriteKey, writtenBytes: number, writeDurationMs: number) {
        const ifNotSet: StorageWriterStatistics = {
            totalScheduledWrites: 1,
            totalWrites: 1,
            totalWrittenBytes: writtenBytes,
            totalWriteTime: writeDurationMs,
            lastWrite: new Date(),
        };
        const stats = this.statistics.update(key, ifNotSet, (stats) => ({
            ...stats,
            totalWrites: stats.totalWrites + 1,
            totalWrittenBytes: stats.totalWrittenBytes + writtenBytes,
            totalWriteTime: stats.totalWriteTime + writeDurationMs,
            lastWrite: new Date(),
        }));
        this.updateStatistics(stats);
    }

    /// The backend as session registry, connection writes need one
    protected requireRegistry(): SessionRegistryBackend {
        if (!isSessionRegistryBackend(this.backend)) {
            throw new Error('the storage backend does not own a session registry');
        }
        return this.backend;
    }

    /// Patch an existing session file, the write is skipped when nothing changed.
    /// A missing file is not recreated, a moved native folder would otherwise come back as a new one.
    private async patchSessionFile(key: string, sessionId: string, patch: (session: SessionData) => SessionData): Promise<void> {
        let existing: SessionData;
        try {
            existing = await this.backend.loadSession(sessionId);
        } catch (e: any) {
            throw new SessionUnavailableError(sessionId, e);
        }
        const next = patch(existing);
        if (sessionManifestEquals(existing, next)) return;
        this.logger.info("Patching session", { key, sessionId }, LOG_CTX);
        const timeBefore = new Date();
        await this.backend.saveSessionManifest(sessionId, next);
        const actualPath = `${sessionId}/${STORAGE_SESSION_FILE}`;
        this.registerWrite(actualPath, JSON.stringify(next).length, new Date().getTime() - timeBefore.getTime());
        this.completedFileContents.set(actualPath, JSON.stringify(next, null, 2));
    }

    protected async executeTask(key: string, task: StorageWriteTaskVariant) {
        switch (task.type) {
            case WRITE_SESSION_MANIFEST: {
                const [sessionId, defaultConnectionId, connections] = task.value;
                this.logger.info("Writing session", {
                    key,
                    sessionId,
                }, LOG_CTX);

                if (!connections.some(connection => connection.connectionId === defaultConnectionId)) {
                    throw new Error(`default connection ${defaultConnectionId} is not a connection of session ${sessionId}`);
                }

                // Load whatever is already on disk so we can (a) preserve the original createdAt
                // instead of churning a fresh timestamp on every write, and (b) skip the write
                // entirely when nothing actually changed. WRITE_SESSION_MANIFEST is scheduled on
                // every connection-state change, so most of these tasks rewrite identical content.
                let existingSession: SessionData | null = null;
                try {
                    existingSession = await this.backend.loadSession(sessionId);
                } catch {
                    existingSession = null;
                }

                // For now, create minimal session metadata
                const sessionMetadata: StorageSessionMetadata = {
                    ...existingSession?.metadata,
                    createdAt: existingSession?.metadata?.createdAt ?? new Date().toISOString(),
                };

                // sessionPath is a display-only field, recomputed from the UUID + location for
                // the UI; we don't persist it here. storageType/nativePath are stamped by the
                // composite backend, which knows the session's physical location.
                // The given connections replace the copies on disk, the scripts keep theirs
                const connData: SessionData = withSessionScripts({
                    formatVersion: SESSION_FORMAT_VERSION,
                    sessionId,
                    ...(existingSession?.name ? { name: existingSession.name } : {}),
                    defaultConnectionId,
                    connections,
                    scripts: [],
                    attachments: existingSession?.attachments ?? [],
                    metadata: sessionMetadata,
                    ...(existingSession?.settings ? { settings: existingSession.settings } : {}),
                }, existingSession?.scripts ?? [], existingSession?.connections ?? []);

                // Skip the write if the persisted manifest already matches what we'd write.
                if (existingSession != null && sessionManifestEquals(existingSession, connData)) {
                    this.logger.debug("Skipping session write: manifest unchanged", {
                        sessionId,
                        connectionIds: connections.map(connection => connection.connectionId).join(','),
                    }, LOG_CTX);
                    break;
                }

                const timeBefore = new Date();
                await this.backend.saveSessionManifest(sessionId, connData);
                const timeAfter = new Date();
                const writeDuration = timeAfter.getTime() - timeBefore.getTime();
                const actualPath = `${sessionId}/dashql-session.json`;
                this.registerWrite(actualPath, JSON.stringify(connData).length, writeDuration);
                this.completedFileContents.set(actualPath, JSON.stringify(connData, null, 2));
                break;
            }
            case WRITE_SESSION_PROPERTIES: {
                const [sessionId, { name, settings }] = task.value;
                const existing = await this.backend.loadSession(sessionId);
                const next: SessionData = { ...existing, settings };
                if (name) next.name = name;
                else delete next.name;
                if (sessionManifestEquals(existing, next)) break;
                const timeBefore = new Date();
                await this.backend.saveSessionManifest(sessionId, next);
                const timeAfter = new Date();
                const actualPath = `${sessionId}/dashql-session.json`;
                this.registerWrite(actualPath, JSON.stringify(next).length, timeAfter.getTime() - timeBefore.getTime());
                this.completedFileContents.set(actualPath, JSON.stringify(next, null, 2));
                break;
            }
            case WRITE_SESSION_CATALOG_SCRIPT: {
                const [sessionId, catalogRelationScript] = task.value;
                this.logger.info("Writing session schema", {
                    key,
                    sessionId,
                }, LOG_CTX);

                // Get the SQL from the catalog script
                const schemaSQL = catalogRelationScript.toString();

                const timeBefore = new Date();
                await this.backend.saveSessionSchema(sessionId, schemaSQL);
                const timeAfter = new Date();
                const writeDuration = timeAfter.getTime() - timeBefore.getTime();
                const actualPath = `${sessionId}/${STORAGE_CATALOG_RELATIONS}`;
                this.registerWrite(actualPath, schemaSQL.length, writeDuration);
                this.completedFileContents.set(actualPath, schemaSQL);
                break;
            }
            case WRITE_SESSION_FUNCTION_SCRIPT: {
                const [sessionId, functionScript] = task.value;
                this.logger.info("Writing session functions", {
                    key,
                    sessionId,
                }, LOG_CTX);

                const functionsSQL = functionScript.toString();

                const timeBefore = new Date();
                await this.backend.saveSessionFunctions(sessionId, functionsSQL);
                const timeAfter = new Date();
                const writeDuration = timeAfter.getTime() - timeBefore.getTime();
                const actualPath = `${sessionId}/${STORAGE_CATALOG_FUNCTIONS}`;
                this.registerWrite(actualPath, functionsSQL.length, writeDuration);
                this.completedFileContents.set(actualPath, functionsSQL);
                break;
            }
            case WRITE_SESSION_CATALOG_CHANGES: {
                const [sessionId, changesSql] = task.value;
                this.logger.info("Writing session catalog changes", {
                    key,
                    sessionId,
                }, LOG_CTX);

                const timeBefore = new Date();
                await this.backend.saveSessionCatalogChanges(sessionId, changesSql);
                const timeAfter = new Date();
                const actualPath = `${sessionId}/${STORAGE_CATALOG_CHANGES}`;
                this.registerWrite(actualPath, changesSql.length, timeAfter.getTime() - timeBefore.getTime());
                this.completedFileContents.set(actualPath, changesSql);
                break;
            }
            case REPLACE_SESSION_SCRIPTS: {
                const session = task.value;
                const sessionId = session.sessionId;
                this.logger.info("Creating session", {
                    key,
                    sessionId,
                }, LOG_CTX);

                for (const script of session.scripts) {
                    const sql = script.readText();
                    const t0 = new Date();
                    await this.backend.saveScript(sessionId, script.fileName, sql);
                    const t1 = new Date();
                    this.registerWrite(`${sessionId}/scripts/${script.fileName}`, sql.length, t1.getTime() - t0.getTime());
                    this.completedFileContents.set(`${sessionId}/scripts/${script.fileName}`, sql);
                }

                // Save session last so it never references content that doesn't exist yet.
                // Preserve the original createdAt across rewrites; only stamp it on the first write.
                let defaultConnectionId: SessionData['defaultConnectionId'];
                let connections: SessionData['connections'];
                let createdAt: string;
                // Preserve the user-supplied name across a session rewrite: this path rebuilds the
                // whole manifest from session scripts, which carry no name, so we must carry over
                // whatever the user already set on disk.
                let existingName: string | undefined;
                let existingMetadata: StorageSessionMetadata | undefined;
                let existingAttachments: SessionData['attachments'] = [];
                let existingScripts: SessionData['scripts'] = [];
                try {
                    const existingSession = await this.backend.loadSession(sessionId);
                    existingScripts = existingSession.scripts ?? [];
                    defaultConnectionId = existingSession.defaultConnectionId;
                    connections = existingSession.connections;
                    createdAt = existingSession.metadata?.createdAt ?? new Date().toISOString();
                    existingName = existingSession.name;
                    existingMetadata = existingSession.metadata;
                    existingAttachments = existingSession.attachments ?? [];
                } catch {
                    defaultConnectionId = session.defaultConnection.connectionId;
                    connections = [session.defaultConnection];
                    createdAt = new Date().toISOString();
                }

                const sessionMetadata: StorageSessionMetadata = {
                    ...existingMetadata,
                    originalFileName: session.originalFileName,
                    createdAt,
                };

                const connData: SessionData = withSessionScripts({
                    formatVersion: SESSION_FORMAT_VERSION,
                    sessionId,
                    ...(session.name ? { name: session.name } : existingName ? { name: existingName } : {}),
                    defaultConnectionId,
                    connections,
                    scripts: [],
                    attachments: existingAttachments,
                    metadata: sessionMetadata,
                    settings: session.settings,
                }, existingScripts);

                const sessionTimeBefore = new Date();
                await this.backend.saveSessionManifest(sessionId, connData);
                const sessionTimeAfter = new Date();
                this.registerWrite(`${sessionId}/dashql-session.json`, JSON.stringify(connData).length, sessionTimeAfter.getTime() - sessionTimeBefore.getTime());
                this.completedFileContents.set(`${sessionId}/dashql-session.json`, JSON.stringify(connData, null, 2));

                break;
            }
            case WRITE_SESSION_SCRIPTS: {
                const [sessionId, list] = task.value;
                await this.patchSessionFile(key, sessionId, session => withSessionScripts(session, list.scripts, list.connections));
                break;
            }
            case REFRESH_SESSION_ATTACHMENTS: {
                const sessionId = task.value;
                const attachments = sessionAttachments((await this.backend.listDataFiles(sessionId)).map(file => file.name));
                await this.patchSessionFile(key, sessionId, session => ({ ...session, attachments }));
                break;
            }
            case WRITE_CONNECTION_ENTRY: {
                const entry = task.value;
                const registry = this.requireRegistry();
                const timeBefore = new Date();
                await registry.updateConnections(connections => upsertConnectionEntry(connections, entry));
                this.registerWrite(key, JSON.stringify(entry).length, new Date().getTime() - timeBefore.getTime());
                break;
            }
            case DELETE_CONNECTION_ENTRY: {
                const connectionId = task.value;
                const registry = this.requireRegistry();
                this.logger.info("Deleting connection", { key, connectionId }, LOG_CTX);
                await registry.updateConnections(connections => {
                    if (connections == null || !connections.some(e => e.id === connectionId)) return null;
                    return connections.filter(e => e.id !== connectionId);
                });
                await registry.deleteConnectionFiles(connectionId);
                break;
            }
            case WRITE_CONNECTION_FILE: {
                const [connectionId, fileName, text] = task.value;
                const registry = this.requireRegistry();
                const timeBefore = new Date();
                await registry.saveConnectionFile(connectionId, fileName, text);
                const actualPath = `@${STORAGE_CONNECTIONS_FOLDER}/${connectionId}/${fileName}`;
                this.registerWrite(actualPath, text.length, new Date().getTime() - timeBefore.getTime());
                this.completedFileContents.set(actualPath, text);
                break;
            }
            case PATCH_SESSION_CONNECTION: {
                const [sessionId, copy, aliases] = task.value;
                const connectionId = copy.connectionId;
                // The copy is only patched into an existing session file. A missing file must not be
                // recreated, a moved native folder would otherwise silently come back as a new one.
                let existing: SessionData;
                try {
                    existing = await this.backend.loadSession(sessionId);
                } catch (e: any) {
                    throw new SessionUnavailableError(sessionId, e);
                }
                const next = patchSessionConnection(existing, copy, aliases);
                if (next == null) break;
                this.logger.info("Writing connection copy", { key, sessionId, connectionId }, LOG_CTX);
                const timeBefore = new Date();
                await this.backend.saveSessionManifest(sessionId, next);
                const actualPath = `${sessionId}/${STORAGE_SESSION_FILE}`;
                this.registerWrite(actualPath, JSON.stringify(next).length, new Date().getTime() - timeBefore.getTime());
                this.completedFileContents.set(actualPath, JSON.stringify(next, null, 2));
                break;
            }
            case WRITE_SCRIPT: {
                const [sessionId, fileName, sql] = task.value;

                this.logger.info("Writing session script", {
                    key,
                    sessionId,
                    file: fileName,
                }, LOG_CTX);

                const timeBefore = new Date();
                await this.backend.saveScript(sessionId, fileName, sql);
                const actualPath = `${sessionId}/scripts/${fileName}`;
                const timeAfter = new Date();
                this.registerWrite(actualPath, sql.length, timeAfter.getTime() - timeBefore.getTime());
                this.completedFileContents.set(actualPath, sql);
                break;
            }
            case DELETE_SESSION:
                this.logger.info("Deleting session", {
                    task: key,
                    sessionId: task.value
                }, LOG_CTX);
                await this.backend.deleteSession(task.value);
                for (const path of this.completedFileContents.keys()) {
                    if (storageWriteKeyBelongsToSession(path, task.value)) {
                        this.completedFileContents.set(path, null);
                    }
                }
                break;
            case DELETE_SCRIPT: {
                const [sessionId, scriptName] = task.value;
                this.logger.info("Deleting session script", {
                    task: key,
                    sessionId,
                    scriptName,
                }, LOG_CTX);
                await this.backend.deleteScript(sessionId, scriptName);
                this.completedFileContents.set(`${sessionId}/scripts/${scriptName}`, null);
                break;
            }
            case RENAME_SCRIPT: {
                const [sessionId, oldScriptName, newScriptName] = task.value;
                this.logger.info("Renaming session script", {
                    task: key,
                    sessionId,
                    oldScriptName,
                    newScriptName,
                }, LOG_CTX);
                await this.backend.renameScript(sessionId, oldScriptName, newScriptName);
                const oldPath = `${sessionId}/scripts/${oldScriptName}`;
                const newPath = `${sessionId}/scripts/${newScriptName}`;
                const content = this.completedFileContents.get(oldPath);
                this.completedFileContents.set(oldPath, null);
                if (content !== undefined) {
                    this.completedFileContents.set(newPath, content);
                }
                break;
            }
        }
    }
}
