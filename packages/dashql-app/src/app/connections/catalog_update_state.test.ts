import { describe, expect, it, vi } from 'vitest';

import { CatalogUpdateTaskStatus, CatalogUpdateVariant, isCatalogRefreshRunning, reduceCatalogAction, type CatalogUpdateTaskState } from './catalog_update_state.js';
import {
    CATALOG_UPDATE_CANCELLED,
    CATALOG_UPDATE_FAILED,
    CATALOG_UPDATE_PARTIALLY_SUCCEEDED,
    CATALOG_UPDATE_SUCCEEDED,
    UPDATE_CATALOG,
    type AttachedDatabaseState,
    type CatalogAction,
} from './attached_database_state.js';

function createConnection(currentFullRefresh: number | null, runningTaskIds: number[]): AttachedDatabaseState {
    return {
        catalogUpdates: {
            currentFullRefresh,
            tasksRunning: new Map(runningTaskIds.map(taskId => [taskId, {}])),
        },
    } as unknown as AttachedDatabaseState;
}

describe('isCatalogRefreshRunning', () => {
    it('returns true while the current full refresh is running', () => {
        expect(isCatalogRefreshRunning(createConnection(7, [7]))).toBe(true);
    });

    it('returns false after the current full refresh completes', () => {
        expect(isCatalogRefreshRunning(createConnection(7, []))).toBe(false);
    });

    it('ignores other running catalog tasks', () => {
        expect(isCatalogRefreshRunning(createConnection(7, [8]))).toBe(false);
    });

    it('returns false without a connection', () => {
        expect(isCatalogRefreshRunning(null)).toBe(false);
    });
});

describe('reduceCatalogAction', () => {
    const terminalActions: CatalogAction[] = [
        { type: CATALOG_UPDATE_CANCELLED, value: [7, new Error('cancelled')] },
        { type: CATALOG_UPDATE_FAILED, value: [7, new Error('failed')] },
        { type: CATALOG_UPDATE_SUCCEEDED, value: [7] },
        { type: CATALOG_UPDATE_PARTIALLY_SUCCEEDED, value: [7, new Error('partial')] },
    ];
    it.each(terminalActions)('preserves a superseding refresh for terminal action $type', action => {
        const task = (taskId: number): CatalogUpdateTaskState => ({
            taskId,
            taskVariant: CatalogUpdateVariant.FULL_CATALOG_REFRESH,
            status: CatalogUpdateTaskStatus.STARTED,
            cancellation: new AbortController(),
            queries: [],
            error: null,
            startedAt: new Date(),
            finishedAt: null,
            lastUpdateAt: new Date(),
        });
        for (const newerFinishedFirst of [false, true]) {
            let state = {
                catalogUpdates: {
                    tasksRunning: new Map(),
                    tasksFinished: new Map(),
                    currentFullRefresh: null,
                    lastFullRefresh: 6,
                    restoredAt: null,
                },
            } as unknown as AttachedDatabaseState;
            const storage = {} as any;
            state = reduceCatalogAction(state, { type: UPDATE_CATALOG, value: [7, task(7)] }, storage);
            state = reduceCatalogAction(state, { type: UPDATE_CATALOG, value: [8, task(8)] }, storage);
            if (newerFinishedFirst) {
                state = reduceCatalogAction(state, { type: CATALOG_UPDATE_SUCCEEDED, value: [8] }, storage);
            }
            state = reduceCatalogAction(state, action, storage);
            expect(state.catalogUpdates.tasksRunning.has(7)).toBe(false);
            expect(state.catalogUpdates.tasksFinished.has(7)).toBe(true);
            expect(state.catalogUpdates.currentFullRefresh).toBe(8);
            expect(state.catalogUpdates.lastFullRefresh).toBe(newerFinishedFirst ? 8 : 6);
            expect(isCatalogRefreshRunning(state)).toBe(!newerFinishedFirst);
            if (!newerFinishedFirst) {
                state = reduceCatalogAction(state, { type: CATALOG_UPDATE_SUCCEEDED, value: [8] }, storage);
            }
            expect(state.catalogUpdates.currentFullRefresh).toBe(8);
            expect(state.catalogUpdates.lastFullRefresh).toBe(8);
            expect(isCatalogRefreshRunning(state)).toBe(false);
        }
    });

    it('finishes a partially successful refresh for the registry to persist', () => {
        const error = new Error('second: unavailable');
        const task = {
            taskId: 7,
            taskVariant: CatalogUpdateVariant.FULL_CATALOG_REFRESH,
            status: CatalogUpdateTaskStatus.STARTED,
            cancellation: new AbortController(),
            queries: [],
            error: null,
            startedAt: new Date(),
            finishedAt: null,
            lastUpdateAt: new Date(),
        };
        const state = {
            active: true,
            databaseId: 'database',
            catalogRelationScript: {},
            catalogFunctionScript: {},
            catalogUpdates: {
                tasksRunning: new Map([[7, task]]),
                tasksFinished: new Map(),
                currentFullRefresh: 7,
                lastFullRefresh: null,
                restoredAt: null,
            },
        } as unknown as AttachedDatabaseState;
        const storage = { write: vi.fn() };

        const next = reduceCatalogAction(state, {
            type: CATALOG_UPDATE_PARTIALLY_SUCCEEDED,
            value: [7, error],
        }, storage as any);

        const finished = next.catalogUpdates.tasksFinished.get(7)!;
        expect(finished.status).toBe(CatalogUpdateTaskStatus.PARTIALLY_SUCCEEDED);
        expect(finished.error).toBe(error);
        expect(next.catalogUpdates.tasksRunning.has(7)).toBe(false);
        expect(storage.write).not.toHaveBeenCalled();
    });
});
