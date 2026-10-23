import { describe, expect, it } from 'vitest';

import {
    SessionViewMode,
    sessionViewModeFromSearch,
    sessionViewNavigation,
    sessionViewSearch,
} from './session_view_mode.js';

describe('session view URL state', () => {
    it('reads Dashboard from the view query parameter only when enabled', () => {
        expect(sessionViewModeFromSearch('?view=dashboard', false)).toBe(SessionViewMode.Session);
        expect(sessionViewModeFromSearch('?view=dashboard', true)).toBe(SessionViewMode.Dashboard);
        expect(sessionViewModeFromSearch('?view=session', true)).toBe(SessionViewMode.Session);
    });

    it('replaces only the view parameter and preserves other query state', () => {
        expect(sessionViewSearch('?foo=bar', SessionViewMode.Dashboard)).toBe('?foo=bar&view=dashboard');
        expect(sessionViewSearch('?foo=bar&view=dashboard', SessionViewMode.Shell)).toBe('?foo=bar');
    });

    it('preserves router state when replacing the view query parameter', () => {
        const state = { appLoadingStatus: 2, sessionId: 'session' };
        expect(sessionViewNavigation({
            pathname: '/sessions/session',
            search: '?foo=bar',
            hash: '#result',
            state,
        }, SessionViewMode.Dashboard)).toEqual({
            to: {
                pathname: '/sessions/session',
                search: '?foo=bar&view=dashboard',
                hash: '#result',
            },
            options: { replace: true, state },
        });
    });
});
