import { describe, expect, it } from 'vitest';

import { sessionIdFromPathname, sessionPath } from './router.js';

describe('session routes', () => {
    it('builds and reads the canonical session route', () => {
        expect(sessionPath('session id')).toBe('/sessions/session%20id');
        expect(sessionIdFromPathname('/sessions/session%20id')).toBe('session id');
    });

    it('ignores non-session and malformed routes', () => {
        expect(sessionIdFromPathname('/')).toBeNull();
        expect(sessionIdFromPathname('/sessions/%E0%A4%A')).toBeNull();
    });
});
