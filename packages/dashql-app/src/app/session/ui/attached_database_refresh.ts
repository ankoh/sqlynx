import { ConnectionHealth, type AttachedDatabaseState } from '../connections/attached_database_state.js';
import { isCatalogRefreshRunning } from '../connections/catalog_update_state.js';

export function canRefreshAttachedDatabase(database: AttachedDatabaseState): boolean {
    return database.connectionHealth === ConnectionHealth.ONLINE &&
        database.connectorInfo.features.refreshSchemaAction &&
        !isCatalogRefreshRunning(database);
}
