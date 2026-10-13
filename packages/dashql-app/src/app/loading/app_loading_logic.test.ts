import { describe, expect, it, vi } from 'vitest';

import { canShowNotebook, loadApp, selectStartupNotebook, shouldFinishInitialNavigation } from './app_loading_logic.js';
import { AppLoadingStatus } from '../router/app_loading_status.js';
import { NotebookSetupStatus } from '../router/notebook_setup_status.js';

describe('canShowNotebook', () => {
    it.each([NotebookSetupStatus.OPENING, NotebookSetupStatus.CONFIGURING, NotebookSetupStatus.NONE])('shows an opened notebook without waiting for connection setup (%s)', notebookSetupStatus => {
        expect(canShowNotebook({
            appLoadingStatus: AppLoadingStatus.SETUP_DONE,
            notebookId: 'offline-notebook',
            notebookSetupStatus,
            confirmedFinishedSetup: false,
        }, false)).toBe(true);
    });
});

describe('selectStartupNotebook', () => {
    it('selects the first restored notebook', () => {
        expect(selectStartupNotebook(['first', 'second'])).toBe('first');
    });

    it('returns null when no valid notebook was restored', () => {
        expect(selectStartupNotebook([])).toBeNull();
    });
});

describe('shouldFinishInitialNavigation', () => {
    it('does not replace navigation after an initial shared notebook was opened', async () => {
        await expect(shouldFinishInitialNavigation(Promise.resolve(true))).resolves.toBe(false);
    });

    it('finishes fallback navigation when the initial shared notebook was not opened', async () => {
        await expect(shouldFinishInitialNavigation(Promise.resolve(false))).resolves.toBe(true);
    });

    it('finishes normal startup navigation without an inline setup', async () => {
        await expect(shouldFinishInitialNavigation(null)).resolves.toBe(true);
    });
});

describe('loadApp', () => {
    it('restores empty state without creating a connection or notebook', async () => {
        const restored = {
            connectionStates: new Map(),
            attachedDatabasesByNotebook: new Map(),
            connectionStatesByType: [[], [], [], []],
            connectionSignatures: new Map(),
            notebookScripts: new Map(),
            notebookScriptsByConnection: new Map(),
            notebookScriptsByConnectionType: [[], [], [], []],
            invalidNotebooks: new Map(),
        };
        const storage = { restoreAppState: vi.fn().mockResolvedValue(restored) };
        const resetConnections = vi.fn();
        const resetNotebookScripts = vi.fn();
        const logger = {
            childSpan: () => ({
                info: vi.fn(),
            }),
        };

        const result = await loadApp(
            logger as any,
            {} as any,
            storage as any,
            resetConnections,
            resetNotebookScripts,
            vi.fn(),
        );

        expect(resetConnections).toHaveBeenCalledOnce();
        expect(resetConnections.mock.calls[0][0].attachedDatabases.size).toBe(0);
        expect(resetNotebookScripts).toHaveBeenCalledOnce();
        expect(resetNotebookScripts.mock.calls[0][0].notebookScriptsMap.size).toBe(0);
        expect(result.invalidNotebooks.size).toBe(0);
        expect(result.restoredNotebookIds).toEqual([]);
    });

    it('preserves restored notebook manifest order for startup selection', async () => {
        const restored = {
            connectionStates: new Map(),
            attachedDatabasesByNotebook: new Map(),
            connectionStatesByType: [[], [], [], []],
            connectionSignatures: new Map(),
            notebookScripts: new Map([['second', {}], ['first', {}]]),
            notebookScriptsByConnection: new Map(),
            notebookScriptsByConnectionType: [[], [], [], []],
            invalidNotebooks: new Map(),
        };
        const result = await loadApp(
            { childSpan: () => ({ info: vi.fn() }) } as any,
            {} as any,
            { restoreAppState: vi.fn().mockResolvedValue(restored) } as any,
            vi.fn(),
            vi.fn(),
            vi.fn(),
        );
        expect(result.restoredNotebookIds).toEqual(['second', 'first']);
        expect(selectStartupNotebook(result.restoredNotebookIds)).toBe('second');
    });
});
