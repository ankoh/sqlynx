import { describe, expect, it } from 'vitest';

import { BUNDLED_SESSIONS } from './bundled_sessions.js';
import type { SessionData } from '../../storage/storage_backend.js';
import { validateSessionData } from '../../storage/session_validation.js';
import { sanitizeSessionFiles } from '../../storage/session_files.js';

describe('bundled V2 sessions', () => {
    it.each(BUNDLED_SESSIONS)('$name has a valid manifest that lists its scripts', async session => {
        const sessionBase = session.manifestPath.slice(0, session.manifestPath.lastIndexOf('/') + 1);
        const manifestResponse = await fetch(session.manifestPath);
        expect(manifestResponse.ok).toBe(true);
        const manifest = await manifestResponse.json() as SessionData;
        const scriptNames = manifest.scripts.map(script => script.name);
        const scripts = await Promise.all(scriptNames.map(name => fetch(`${sessionBase}scripts/${name}`)));

        expect(validateSessionData(manifest)).toEqual({ ok: true });
        expect(sanitizeSessionFiles(manifest).valid).toBe(true);
        expect(manifest.sessionId).toBe(session.sessionId);
        expect(manifest).not.toHaveProperty('nativePath');
        expect(scriptNames.length).toBeGreaterThan(0);
        expect(scripts.every(response => response.ok)).toBe(true);
        expect(manifest.scripts.every(script => script.connectionId === manifest.defaultConnectionId)).toBe(true);
    });
});
