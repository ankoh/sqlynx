import { describe, expect, it } from 'vitest';

import { migrateAppEventData } from './legacy_links.js';

describe('legacy links', () => {
    it('renames the embedded notebook of an app event', () => {
        expect(migrateAppEventData({ notebook: 'zip' })).toEqual({ session: 'zip' });
        expect(migrateAppEventData({ session: 'zip' })).toEqual({ session: 'zip' });
        expect(migrateAppEventData({ session: 'new', notebook: 'old' })).toEqual({ session: 'new', notebook: 'old' });
        expect(migrateAppEventData({ oauthRedirect: {} })).toEqual({ oauthRedirect: {} });
        expect(migrateAppEventData(null)).toBeNull();
        expect(migrateAppEventData(['notebook'])).toEqual(['notebook']);
    });
});
