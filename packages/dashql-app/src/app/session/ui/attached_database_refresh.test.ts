import { ConnectionHealth, type AttachedDatabaseState } from '../connections/attached_database_state.js';
import { canRefreshAttachedDatabase } from './attached_database_refresh.js';

function database(overrides: Partial<AttachedDatabaseState> = {}): AttachedDatabaseState {
    return {
        connectionHealth: ConnectionHealth.ONLINE,
        connectorInfo: { features: { refreshSchemaAction: true } },
        catalogUpdates: {
            currentFullRefresh: null,
            tasksRunning: new Map(),
        },
        ...overrides,
    } as AttachedDatabaseState;
}

describe('attached database catalog refresh', () => {
    it('is available only for online refreshable databases without an active refresh', () => {
        expect(canRefreshAttachedDatabase(database())).toBe(true);
        expect(canRefreshAttachedDatabase(database({ connectionHealth: ConnectionHealth.FAILED }))).toBe(false);
        expect(canRefreshAttachedDatabase(database({
            connectorInfo: { features: { refreshSchemaAction: false } } as any,
        }))).toBe(false);
        expect(canRefreshAttachedDatabase(database({
            catalogUpdates: {
                currentFullRefresh: 7,
                tasksRunning: new Map([[7, {} as any]]),
            } as any,
        }))).toBe(false);
    });
});
