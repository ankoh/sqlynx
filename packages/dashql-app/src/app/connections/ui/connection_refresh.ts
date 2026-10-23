import { ConnectionHealth, type ConnectionState } from '../connection_state.js';
import { isCatalogRefreshRunning } from '../catalog_update_state.js';

export function canRefreshConnection(database: ConnectionState): boolean {
    return database.connectionHealth === ConnectionHealth.ONLINE &&
        !isCatalogRefreshRunning(database);
}
