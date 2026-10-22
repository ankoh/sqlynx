import { describe, expect, it, vi } from 'vitest';

import { canShowSession, loadApp, selectStartupSession, shouldFinishInitialNavigation } from './app_loading_logic.js';
import { AppLoadingStatus } from '../router/app_loading_status.js';
import { SessionSetupStatus } from '../router/session_setup_status.js';

describe('canShowSession', () => {
    it.each([SessionSetupStatus.OPENING, SessionSetupStatus.CONFIGURING, SessionSetupStatus.NONE])('shows an opened session without waiting for connection setup (%s)', sessionSetupStatus => {
        expect(canShowSession({
            appLoadingStatus: AppLoadingStatus.SETUP_DONE,
            sessionId: 'offline-session',
            sessionSetupStatus,
            confirmedFinishedSetup: false,
        }, false)).toBe(true);
    });
});

describe('selectStartupSession', () => {
    it('selects the first restored session', () => {
        expect(selectStartupSession(['first', 'second'])).toBe('first');
    });

    it('returns null when no valid session was restored', () => {
        expect(selectStartupSession([])).toBeNull();
    });
});

describe('shouldFinishInitialNavigation', () => {
    it('does not replace navigation after an initial shared session was opened', async () => {
        await expect(shouldFinishInitialNavigation(Promise.resolve(true))).resolves.toBe(false);
    });

    it('finishes fallback navigation when the initial shared session was not opened', async () => {
        await expect(shouldFinishInitialNavigation(Promise.resolve(false))).resolves.toBe(true);
    });

    it('finishes normal startup navigation without an inline setup', async () => {
        await expect(shouldFinishInitialNavigation(null)).resolves.toBe(true);
    });
});

describe('loadApp', () => {
    it('restores empty state without creating a connection or session', async () => {
        const restored = {
            connectionStates: new Map(),
            attachedDatabasesBySession: new Map(),
            connectionStatesByType: [[], [], [], []],
            connectionSignatures: new Map(),
            sessionScripts: new Map(),
            sessionScriptsByConnection: new Map(),
            sessionScriptsByConnectionType: [[], [], [], []],
            invalidSessions: new Map(),
        };
        const storage = { restoreAppState: vi.fn().mockResolvedValue(restored) };
        const resetConnections = vi.fn();
        const resetSessionScripts = vi.fn();
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
            resetSessionScripts,
            vi.fn(),
        );

        expect(resetConnections).toHaveBeenCalledOnce();
        expect(resetConnections.mock.calls[0][0].attachedDatabases.size).toBe(0);
        expect(resetSessionScripts).toHaveBeenCalledOnce();
        expect(resetSessionScripts.mock.calls[0][0].sessionScriptsMap.size).toBe(0);
        expect(result.invalidSessions.size).toBe(0);
        expect(result.restoredSessionIds).toEqual([]);
    });

    it('preserves restored session manifest order for startup selection', async () => {
        const restored = {
            connectionStates: new Map(),
            attachedDatabasesBySession: new Map(),
            connectionStatesByType: [[], [], [], []],
            connectionSignatures: new Map(),
            sessionScripts: new Map([['second', {}], ['first', {}]]),
            sessionScriptsByConnection: new Map(),
            sessionScriptsByConnectionType: [[], [], [], []],
            invalidSessions: new Map(),
        };
        const result = await loadApp(
            { childSpan: () => ({ info: vi.fn() }) } as any,
            {} as any,
            { restoreAppState: vi.fn().mockResolvedValue(restored) } as any,
            vi.fn(),
            vi.fn(),
            vi.fn(),
        );
        expect(result.restoredSessionIds).toEqual(['second', 'first']);
        expect(selectStartupSession(result.restoredSessionIds)).toBe('second');
    });
});
