import type { DashQL } from '@ankoh/dashql-core';
import type { Logger } from '../../platform/logger/logger.js';
import { stringifyError } from '../../platform/logger/logger.js';
import type { ConnectionState } from './connection_state.js';
import { decodeConnectionFromProto, restoreConnectionState } from './connection_import.js';
import { connectionCatalogIsDurable } from './connection_params.js';
import { CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK } from './catalog_update_state.js';
import { beginCatalogBatch, invalidateCatalogBatch, publishCatalogBatch, type BatchProcessor, type CatalogBatchEntry } from './catalog_batch.js';
import type { SessionConnection, SessionRegistryBackend } from '../storage/storage_backend.js';
import { STORAGE_CATALOG_CHANGES, STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_RELATIONS } from '../storage/storage_backend.js';

const LOG_CTX = "connection_restore";

/// The stored params of a connection, as the app manifest or a session file holds them
export type StoredConnection = Pick<SessionConnection, 'params' | 'paramsDraft' | 'name'>;

/// Create the state of a connection from its stored params.
/// The connection is neither registered nor written, see `destroyUnregisteredConnection`.
export function connectionStateFromStorage(core: DashQL, connectionId: string, stored: StoredConnection): ConnectionState {
    const [connectorInfo, details] = decodeConnectionFromProto(stored.params as any, connectionId);
    return restoreConnectionState(core, connectionId, connectorInfo, details, stored.paramsDraft, stored.name);
}

/// Destroy a connection that was created but never registered
export function destroyUnregisteredConnection(connection: ConnectionState): void {
    invalidateCatalogBatch(connection.catalog);
    connection.catalog.dropDescriptor(connection.catalogRelationScript.catalog_entry_id);
    connection.catalog.dropDescriptor(connection.catalogFunctionScript.catalog_entry_id);
    connection.catalogRelationScript.destroy();
    connection.catalogFunctionScript.destroy();
    connection.catalog.destroy();
}

/// What restoring a catalog needs
export interface CatalogRestoreContext {
    /// The core instance
    core: DashQL;
    /// The logger
    logger: Logger;
    /// The processor of catalog batches, the core processes them if absent
    processor?: BatchProcessor;
}

/// The outcome of restoring the catalog of a connection from its files
export interface ConnectionCatalogRestore {
    /// False if the restoration failed, the connection refreshes its catalog on connect
    succeeded: boolean;
    /// The files whose relations or changes were dropped, they are cleared
    staleFiles: string[];
}

/// Restore the catalog of a connection from the files of the connection.
///
/// The relations and changes of a connection whose database doesn't outlive the app describe a
/// database that is gone, they are dropped and their files are reported as stale. Such a catalog is
/// described by a refresh on connect. A restored catalog is kept until an explicit refresh.
export async function restoreConnectionCatalog(
    ctx: CatalogRestoreContext,
    registry: SessionRegistryBackend,
    connection: ConnectionState,
    logContext: Record<string, string>,
): Promise<ConnectionCatalogRestore> {
    const { connectionId, catalog, catalogRelationScript, catalogFunctionScript } = connection;
    const durable = connectionCatalogIsDurable(connection.params);
    const staleFiles: string[] = [];
    try {
        const validate = beginCatalogBatch(catalog);
        const [relations, functions, changes] = await Promise.all([
            registry.loadConnectionFile(connectionId, STORAGE_CATALOG_RELATIONS),
            registry.loadConnectionFile(connectionId, STORAGE_CATALOG_FUNCTIONS),
            registry.loadConnectionFile(connectionId, STORAGE_CATALOG_CHANGES),
        ]);
        validate();
        if (!durable) {
            // Clear the dropped relations and changes that older versions of the app wrote
            if (relations) staleFiles.push(STORAGE_CATALOG_RELATIONS);
            if (changes) staleFiles.push(STORAGE_CATALOG_CHANGES);
        }

        const catalogScripts: CatalogBatchEntry[] = [];
        if (durable && relations && relations.trim().length > 0) {
            ctx.logger.info("Catalog schema loaded", { ...logContext, schemaLength: relations.length.toString() }, LOG_CTX);
            catalogScripts.push({ script: catalogRelationScript, text: relations, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK });
        }
        if (functions && functions.trim().length > 0) {
            ctx.logger.info("Catalog functions loaded", { ...logContext, functionsLength: functions.length.toString() }, LOG_CTX);
            catalogScripts.push({ script: catalogFunctionScript, text: functions, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK });
        }
        if (catalogScripts.length > 0) {
            await publishCatalogBatch(ctx.core, catalog, catalogScripts, { processor: ctx.processor }, validate);
            // Only restored relations make a catalog that is kept
            if (durable) {
                connection.catalogUpdates.restoredAt = new Date();
            }
        }
        if (durable && changes != null && changes.trim().length > 0) {
            restoreCatalogChanges(ctx.logger, connection, changes, logContext);
        }
        return { succeeded: true, staleFiles };
    } catch (error) {
        ctx.logger.warn("Failed to restore connection catalog, will refresh on connect", {
            ...logContext,
            error: stringifyError(error),
        }, LOG_CTX);
        return { succeeded: false, staleFiles };
    }
}

/// Apply the catalog changes of executed statements on top of the restored relation script.
/// Unreadable changes are dropped, the next catalog refresh describes the relations anyway.
function restoreCatalogChanges(logger: Logger, connection: ConnectionState, changesSql: string, logContext: Record<string, string>): void {
    try {
        connection.catalog.applyCatalogChangesSql(connection.catalogRelationScript.catalog_entry_id, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK, changesSql);
        connection.catalogChangesSql = changesSql;
        logger.info("Catalog changes restored", { ...logContext, changesLength: changesSql.length.toString() }, LOG_CTX);
    } catch (error) {
        logger.warn("Failed to restore the catalog changes", { ...logContext, error: stringifyError(error) }, LOG_CTX);
    }
}
