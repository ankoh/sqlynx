import { describe, expect, it } from 'vitest';

import { applyFlavorToDocument, resolveFlavor, withFlavorParameter } from './flavor_resolution.js';
import { applyFlavorSettings, DASHQL_FLAVOR, SIDB_FLAVOR } from './flavors.js';

describe('App flavor resolution', () => {
    it('defaults to DashQL', () => {
        expect(resolveFlavor(null)).toEqual({ flavor: DASHQL_FLAVOR });
    });

    it('selects the requested flavor', () => {
        expect(resolveFlavor('sidb')).toEqual({ flavor: SIDB_FLAVOR });
        expect(resolveFlavor('dashql')).toEqual({ flavor: DASHQL_FLAVOR });
    });

    it('ignores unknown flavors', () => {
        expect(resolveFlavor('unknown')).toEqual({ flavor: DASHQL_FLAVOR, unknownId: 'unknown' });
    });

    it('adds the flavor parameter to urls that lost it', () => {
        expect(withFlavorParameter(new URL('https://dashql.app/notebooks/a'), SIDB_FLAVOR)?.href)
            .toBe('https://dashql.app/notebooks/a?flavor=sidb');
        expect(withFlavorParameter(new URL('https://dashql.app/notebooks/a?data=x#h'), SIDB_FLAVOR)?.href)
            .toBe('https://dashql.app/notebooks/a?data=x&flavor=sidb#h');
        expect(withFlavorParameter(new URL('https://dashql.app/?flavor=sidb'), SIDB_FLAVOR)).toBeNull();
        expect(withFlavorParameter(new URL('https://dashql.app/notebooks/a'), DASHQL_FLAVOR)).toBeNull();
    });
});

describe('App flavor branding', () => {
    function createDocument(): Document {
        const doc = document.implementation.createHTMLDocument('DashQL');
        doc.head.innerHTML = `
            <link rel="apple-touch-icon" href="/static/favicons/dashql/apple-touch-icon.png" />
            <link rel="icon" type="image/png" sizes="32x32" href="/static/favicons/dashql/favicon-32x32.png" />
            <link rel="manifest" href="/static/favicons/dashql/site.webmanifest" />
            <link rel="mask-icon" href="/static/favicons/dashql/safari-pinned-tab.svg" />
            <link rel="shortcut icon" href="/static/favicons/dashql/favicon.ico" />
            <meta name="apple-mobile-web-app-title" content="DashQL" />
        `;
        return doc;
    }

    it('keeps the static favicons of the default flavor', () => {
        const doc = createDocument();
        applyFlavorToDocument(DASHQL_FLAVOR, doc);
        expect(doc.documentElement.dataset.flavor).toBe('dashql');
        expect(doc.title).toBe('DashQL');
        expect(doc.head.querySelectorAll('link').length).toBe(5);
    });

    it('replaces the favicons of a branded flavor', () => {
        const doc = createDocument();
        applyFlavorToDocument(SIDB_FLAVOR, doc);
        expect(doc.documentElement.dataset.flavor).toBe('sidb');
        expect(doc.title).toBe('SIDB');
        expect(doc.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content')).toBe('SIDB');
        const links = [...doc.head.querySelectorAll('link')].map(l => [l.rel, l.getAttribute('href')]);
        expect(links).toEqual([
            ['manifest', '/static/favicons/dashql/site.webmanifest'],
            ['icon', SIDB_FLAVOR.favicon!.href],
        ]);
    });

    it('layers flavor settings over the config settings', () => {
        expect(applyFlavorSettings({ enableTableColumnPlots: true }, DASHQL_FLAVOR)).toEqual({ enableTableColumnPlots: true });
        const flavor = { ...SIDB_FLAVOR, settings: { enableTableColumnPlots: false, keywordCase: 'upper' as const } };
        expect(applyFlavorSettings({ enableTableColumnPlots: true, pauseAfterAppSetup: false }, flavor)).toEqual({
            enableTableColumnPlots: false,
            pauseAfterAppSetup: false,
            keywordCase: 'upper',
        });
        expect(applyFlavorSettings(undefined, flavor)).toEqual({ enableTableColumnPlots: false, keywordCase: 'upper' });
    });
});
