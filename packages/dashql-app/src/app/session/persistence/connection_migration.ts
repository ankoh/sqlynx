import type { Logger } from '../../../platform/logger/logger.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { connectionParamsEqual, connectionParamsKey, connectionParamsWithoutDraftRows } from '../connections/connection_params.js';
import type { AttachedDatabaseRole } from '../connections/attached_database_registry.js';
import {
    type ConnectionEntry,
    type ConnectionParams,
    type SessionData,
    type SessionRegistryBackend,
    STORAGE_CATALOG_CHANGES,
    STORAGE_CATALOG_FUNCTIONS,
    STORAGE_CATALOG_RELATIONS,
} from './storage_backend.js';
import { dedupeAttachedDatabases } from './storage_writer.js';

const LOG_CTX = 'connection_migration';

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
        const rewrite = (database: SessionData['mainDatabase']): SessionData['mainDatabase'] => {
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

/// Apply a migration plan.
///
/// The catalogs are copied first, writing the connections into the manifest is the commit point.
/// A crash before it repeats the migration, the copies are idempotent. The sessions are rewritten
/// last and best effort, the load resolves stale references through the aliases.
/// Returns false if another writer migrated the connections in the meantime.
/// The storage that a migration writes
export type ConnectionMigrationBackend = Pick<SessionRegistryBackend,
    'updateConnections' | 'saveConnectionFile' | 'saveSessionManifest'
    | 'loadSessionSchema' | 'loadSessionFunctions' | 'loadSessionCatalogChanges'>;

export async function applyConnectionMigration(backend: ConnectionMigrationBackend, plan: ConnectionMigrationPlan, logger: Logger): Promise<boolean> {
    for (const [connectionId, sessionId] of plan.catalogSources) {
        try {
            const [relations, functions, changes] = await Promise.all([
                backend.loadSessionSchema(sessionId),
                backend.loadSessionFunctions(sessionId),
                backend.loadSessionCatalogChanges(sessionId),
            ]);
            if (relations != null) await backend.saveConnectionFile(connectionId, STORAGE_CATALOG_RELATIONS, relations);
            if (functions != null) await backend.saveConnectionFile(connectionId, STORAGE_CATALOG_FUNCTIONS, functions);
            if (changes != null) await backend.saveConnectionFile(connectionId, STORAGE_CATALOG_CHANGES, changes);
        } catch (error) {
            // The catalog is a cache, the next refresh describes the relations anyway
            logger.warn('Failed to copy the catalog of a connection', { connectionId, sessionId, error: stringifyError(error) }, LOG_CTX);
        }
    }

    let committed = false;
    await backend.updateConnections(connections => {
        if (connections != null) return null;
        committed = true;
        return plan.entries;
    });
    if (!committed) {
        logger.info('Connections were migrated concurrently', {}, LOG_CTX);
        return false;
    }
    logger.info('Migrated connections', {
        connections: plan.entries.length.toString(),
        sessions: plan.rewrites.size.toString(),
    }, LOG_CTX);

    for (const [sessionId, data] of plan.rewrites) {
        try {
            await backend.saveSessionManifest(sessionId, data);
        } catch (error) {
            logger.warn('Failed to rewrite the connections of a session', { sessionId, error: stringifyError(error) }, LOG_CTX);
        }
    }
    return true;
}
