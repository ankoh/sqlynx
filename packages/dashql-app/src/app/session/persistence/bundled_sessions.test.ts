import { describe, expect, it } from 'vitest';

import { BUNDLED_SESSIONS } from './bundled_sessions.js';
import type { SessionData, SessionIndexData } from './storage_backend.js';
import { validateSessionData } from './session_validation.js';

describe('bundled V2 sessions', () => {
    it.each(BUNDLED_SESSIONS)('$name has a valid manifest and an exact flat script index', async session => {
        const sessionBase = session.manifestPath.slice(0, session.manifestPath.lastIndexOf('/') + 1);
        const [manifestResponse, indexResponse] = await Promise.all([
            fetch(session.manifestPath),
            fetch(`${sessionBase}dashql-session-index.json`),
        ]);
        expect(manifestResponse.ok).toBe(true);
        expect(indexResponse.ok).toBe(true);
        const manifest = await manifestResponse.json() as SessionData;
        const index = await indexResponse.json() as SessionIndexData;
        const scriptNames = index.scripts.map(script => script.name);
        const scripts = await Promise.all(scriptNames.map(name => fetch(`${sessionBase}scripts/${name}`)));

        expect(validateSessionData(manifest)).toEqual({ ok: true });
        expect(manifest.sessionId).toBe(session.sessionId);
        expect(manifest).not.toHaveProperty('nativePath');
        expect(scripts.every(response => response.ok)).toBe(true);
        expect(scriptNames).toEqual([...scriptNames].sort((left, right) => left.localeCompare(right, undefined, { numeric: true })));
        expect(index).toEqual({ scripts: scriptNames.map(name => ({ name })) });
    });
});
