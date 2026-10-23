import { stringifyError } from '../../platform/logger/logger.js';
import { connectionParamsEqual, connectionParamsKey, connectionParamsWithoutDraftRows } from '../../app/connections/connection_params.js';
import type { AttachedDatabaseRole } from '../../app/connections/connection_registry.js';
import type { ConnectionEntry, ConnectionParams } from '../../app/storage/storage_backend.js';
import { isValidUuid } from '../../app/storage/session_validation.js';
import type { MigrationFolder } from '../migration_folder.js';
import { migrateSessionFolder } from '../session_migration.js';
import type { StorageMigrationStep } from '../storage_migration.js';
import { listSessionFolders, readManifestJson, writeManifestJson } from '../storage_root.js';

/// A database that session metadata of format version 4 references
interface SessionDatabase {
    /// The id of the database
    databaseId: string;
    /// The copy of the connection params
    params: ConnectionParams;
    /// Unsaved edits of the params
    paramsDraft?: ConnectionParams;
}

/// The session metadata of format version 4, as far as the step reads it
export interface SessionData extends Record<string, unknown> {
    /// The main database
    mainDatabase: SessionDatabase;
    /// The attached databases
    attachedDatabases: SessionDatabase[];
}

/// Drop attached databases that reference the main database or an earlier attached database
function dedupeAttachedDatabases(mainDatabaseId: string, attached: SessionDatabase[]): SessionDatabase[] {
    const seen = new Set([mainDatabaseId]);
    return attached.filter(database => {
        if (seen.has(database.databaseId)) return false;
        seen.add(database.databaseId);
        return true;
    });
}

const LOG_CTX = 'storage_migration';

/// The session format version the step reads and writes
const SESSION_FORMAT_VERSION = 4;
/// The catalog files that a session copies into the folder of a connection
const CATALOG_FILES = ['dashql-catalog-relations.sql', 'dashql-catalog-functions.sql', 'dashql-catalog-changes.sql'];

/// A session that takes part in the migration
export interface MigratingSession {
    /// The session id
    sessionId: string;
    /// The session data as it is stored
    data: SessionData;
}

/// The plan to make the connections of sessions global
export interface ConnectionMigrationPlan {
    /// The connections of the app manifest
    entries: ConnectionEntry[];
    /// The sessions whose files change, with their new data
    rewrites: Map<string, SessionData>;
    /// The session whose catalog files seed the catalog of a connection (connectionId -> sessionId)
    catalogSources: Map<string, string>;
}

/// A reference of a session to a database
interface DatabaseRef {
    /// The referencing session
    sessionId: string;
    /// Is the database the main database of the session?
    role: AttachedDatabaseRole;
    /// The stored database id
    databaseId: string;
    /// The stored params
    params: ConnectionParams;
    /// The stored draft, if any
    paramsDraft?: ConnectionParams;
}

/// A connection the migration creates
interface PlannedConnection {
    /// The connection id
    id: string;
    /// The saved params
    params: ConnectionParams;
    /// The draft, if any
    paramsDraft?: ConnectionParams;
    /// The references that resolve to the connection
    refs: DatabaseRef[];
}

/// Plan the migration of per-session databases to global connections.
///
/// Databases with equal params (ignoring the form rows of drafts) become one connection. The full
/// params are compared, so databases that differ in a secret stay separate. A connection keeps the id
/// of its first reference in manifest order, the other ids become aliases.
///
/// Drafts must not get lost: references with the same draft (or none) share a connection, every
/// further distinct draft keeps a connection of its own under the id of its first holder.
export function planConnectionMigration(sessions: readonly MigratingSession[]): ConnectionMigrationPlan {
    // Collect the references in manifest order and group them by their params
    const groups = new Map<string, DatabaseRef[]>();
    for (const { sessionId, data } of sessions) {
        const refs: DatabaseRef[] = [
            { sessionId, role: 'main', ...data.mainDatabase },
            ...data.attachedDatabases.map(database => ({ sessionId, role: 'attached' as const, ...database })),
        ];
        for (const ref of refs) {
            const key = connectionParamsKey(connectionParamsWithoutDraftRows(ref.params));
            const group = groups.get(key);
            if (group) group.push(ref); else groups.set(key, [ref]);
        }
    }

    // Split the groups by their drafts
    const usedIds = new Set<string>();
    const claimId = (preferred: string) => {
        const id = usedIds.has(preferred) ? crypto.randomUUID() : preferred;
        usedIds.add(id);
        return id;
    };
    const connections: PlannedConnection[] = [];
    for (const refs of groups.values()) {
        const params = connectionParamsWithoutDraftRows(refs[0].params);
        const byDraft: PlannedConnection[] = [];
        for (const ref of refs) {
            // References without a draft join the first connection of the group
            const target = ref.paramsDraft == null
                ? byDraft[0]
                : byDraft.find(c => c.paramsDraft == null || connectionParamsEqual(c.paramsDraft, ref.paramsDraft));
            if (target) {
                target.refs.push(ref);
                if (target.paramsDraft == null && ref.paramsDraft != null) target.paramsDraft = ref.paramsDraft;
            } else {
                byDraft.push({ id: '', params, paramsDraft: ref.paramsDraft, refs: [ref] });
            }
        }
        for (const connection of byDraft) {
            connection.id = claimId(connection.refs[0].databaseId);
            connections.push(connection);
        }
    }

    // Build the manifest entries and the catalog sources
    const createdAt = new Date().toISOString();
    const entries: ConnectionEntry[] = [];
    const catalogSources = new Map<string, string>();
    const resolve = new Map<string, string>(); // `${sessionId}/${databaseId}` -> connection id
    for (const connection of connections) {
        const aliases = [...new Set(connection.refs.map(ref => ref.databaseId).filter(id => id !== connection.id))];
        entries.push({
            id: connection.id,
            params: connection.params,
            ...(connection.paramsDraft == null ? {} : { paramsDraft: connection.paramsDraft }),
            ...(aliases.length === 0 ? {} : { aliases }),
            createdAt,
        });
        const catalogSource = connection.refs.find(ref => ref.role === 'main');
        if (catalogSource) catalogSources.set(connection.id, catalogSource.sessionId);
        for (const ref of connection.refs) {
            resolve.set(`${ref.sessionId}/${ref.databaseId}`, connection.id);
        }
    }

    // Rewrite the references of the sessions
    const paramsOf = new Map(connections.map(c => [c.id, c.params]));
    const rewrites = new Map<string, SessionData>();
    for (const { sessionId, data } of sessions) {
        const rewrite = (database: SessionDatabase): SessionDatabase => {
            const id = resolve.get(`${sessionId}/${database.databaseId}`)!;
            return { databaseId: id, params: paramsOf.get(id)! };
        };
        const mainDatabase = rewrite(data.mainDatabase);
        const next: SessionData = {
            ...data,
            mainDatabase,
            attachedDatabases: dedupeAttachedDatabases(mainDatabase.databaseId, data.attachedDatabases.map(rewrite)),
        };
        if (JSON.stringify(next) !== JSON.stringify(data)) {
            rewrites.set(sessionId, next);
        }
    }
    return { entries, rewrites, catalogSources };
}

/// Does the metadata of format version 4 hold the databases that the plan reads?
function hasDatabases(data: Record<string, unknown>): boolean {
    const isDatabase = (value: unknown) => value != null && typeof value === 'object'
        && typeof (value as { databaseId?: unknown }).databaseId === 'string'
        && (value as { params?: unknown }).params != null && typeof (value as { params?: unknown }).params === 'object';
    return data.formatVersion === SESSION_FORMAT_VERSION
        && isDatabase(data.mainDatabase)
        && Array.isArray(data.attachedDatabases) && data.attachedDatabases.every(isDatabase);
}

/// Sessions own their connections up to storage version 2. The step moves the connections into the
/// app manifest and consolidates connections with equal params, see `planConnectionMigration`.
///
/// The catalogs are copied first, writing the connections into the manifest is the commit point.
/// The sessions are rewritten last and best effort, the load resolves stale references through the
/// aliases. Sessions that cannot be read register their connections when they become readable again.
export const globalConnections: StorageMigrationStep = {
    version: 3,
    description: 'Move the connections of the sessions into the app manifest',
    async migrate({ root, logger }) {
        const manifest = await readManifestJson(root);
        if (manifest == null || manifest.connections !== undefined) {
            return;
        }

        const sessions: MigratingSession[] = [];
        const folders = new Map<string, MigrationFolder>();
        for (const { sessionId, folder } of await listSessionFolders(root, manifest)) {
            if (!isValidUuid(sessionId)) continue;
            try {
                await migrateSessionFolder(folder, SESSION_FORMAT_VERSION);
                const text = await folder.readText('dashql-session.json');
                const data = text == null ? null : JSON.parse(text) as Record<string, unknown>;
                if (data != null && hasDatabases(data)) {
                    sessions.push({ sessionId, data: data as unknown as SessionData });
                    folders.set(sessionId, folder);
                }
            } catch (error) {
                logger.warn('Skipping the connections of an unreadable session', { sessionId, error: stringifyError(error) }, LOG_CTX);
            }
        }
        const plan = planConnectionMigration(sessions);

        for (const [connectionId, sessionId] of plan.catalogSources) {
            try {
                const connectionDir = await (await root.getDirectoryHandle('connections', { create: true }))
                    .getDirectoryHandle(connectionId, { create: true });
                for (const name of CATALOG_FILES) {
                    const text = await folders.get(sessionId)!.readText(name);
                    if (text == null) continue;
                    const writable = await (await connectionDir.getFileHandle(name, { create: true })).createWritable();
                    await writable.write(text);
                    await writable.close();
                }
            } catch (error) {
                // The catalog is a cache, the next refresh describes the relations anyway
                logger.warn('Failed to copy the catalog of a connection', { connectionId, sessionId, error: stringifyError(error) }, LOG_CTX);
            }
        }

        await writeManifestJson(root, { ...manifest, connections: plan.entries });
        logger.info('Migrated connections', {
            connections: plan.entries.length.toString(),
            sessions: plan.rewrites.size.toString(),
        }, LOG_CTX);

        for (const [sessionId, data] of plan.rewrites) {
            try {
                await folders.get(sessionId)!.writeText('dashql-session.json', JSON.stringify(data, null, 2));
            } catch (error) {
                logger.warn('Failed to rewrite the connections of a session', { sessionId, error: stringifyError(error) }, LOG_CTX);
            }
        }
    },
};
