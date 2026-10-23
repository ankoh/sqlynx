import { ConnectionHealth, type ConnectionState } from '../connection_state.js';
import { canRefreshConnection } from './connection_refresh.js';

function database(overrides: Partial<ConnectionState> = {}): ConnectionState {
    return {
        connectionHealth: ConnectionHealth.ONLINE,
        catalogUpdates: {
            currentFullRefresh: null,
            tasksRunning: new Map(),
        },
        ...overrides,
    } as ConnectionState;
}

describe('attached database catalog refresh', () => {
    it('is available only for online databases without an active refresh', () => {
        expect(canRefreshConnection(database())).toBe(true);
        expect(canRefreshConnection(database({ connectionHealth: ConnectionHealth.FAILED }))).toBe(false);
        expect(canRefreshConnection(database({
            catalogUpdates: {
                currentFullRefresh: 7,
                tasksRunning: new Map([[7, {} as any]]),
            } as any,
        }))).toBe(false);
    });
});
