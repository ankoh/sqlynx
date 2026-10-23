import * as dashql from '@ankoh/dashql-core';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    buildShareUrl,
    decodeShareScript,
    encodeShareScript,
    readShareScriptFromLocation,
    splitShareScript,
} from './shell_share.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let core: dashql.DashQL;
beforeAll(async () => {
    core = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});

afterAll(() => core.resetUnsafe());

describe('Shell share encoding', () => {
    it('round-trips scripts through the URL payload', async () => {
        for (const script of ['select 1;', 'select \'grüße 🦆\';\nselect 2;', 'select 1;\n'.repeat(1000)]) {
            const payload = await encodeShareScript(script);
            expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
            await expect(decodeShareScript(payload)).resolves.toBe(script);
        }
    });

    it('compresses repetitive scripts', async () => {
        const script = 'select * from items where value > 1;\n'.repeat(100);
        expect((await encodeShareScript(script)).length).toBeLessThan(script.length / 10);
    });

    it('rejects payloads that are not encoded scripts', async () => {
        await expect(decodeShareScript('')).rejects.toThrow();
        await expect(decodeShareScript('not+base64url')).rejects.toThrow();
        await expect(decodeShareScript('AAAAAAAA')).rejects.toThrow();
    });
});

describe('Shell share URL', () => {
    let previousUrl: string;

    beforeEach(() => {
        previousUrl = window.location.href;
    });

    afterEach(() => {
        window.history.replaceState(window.history.state, '', previousUrl);
    });

    it('puts the payload into the hash of the current page', () => {
        expect(buildShareUrl('abc', { origin: 'https://hyperdb.sh', pathname: '/', search: '' })).toBe('https://hyperdb.sh/#script=abc');
        expect(buildShareUrl('abc', { origin: 'http://localhost:9002', pathname: '/shell.html', search: '?x=1' }))
            .toBe('http://localhost:9002/shell.html?x=1#script=abc');
    });

    it('reads the payload once and removes it from the address bar', () => {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}?keep=1#other=2&script=abc`);

        expect(readShareScriptFromLocation()).toBe('abc');
        expect(window.location.search).toBe('?keep=1');
        expect(window.location.hash).toBe('#other=2');
        expect(readShareScriptFromLocation()).toBeNull();
    });
});

describe('Shell share script splitting', () => {
    let catalog: dashql.DashQLCatalog;

    beforeEach(() => {
        catalog = core.createCatalog();
    });

    afterEach(() => {
        catalog.destroy();
    });

    it('splits statements and terminates each one', () => {
        expect(splitShareScript(core, catalog, 'select 1; select\n  2;\n\nselect 3')).toEqual([
            'select 1;',
            'select\n  2;',
            'select 3;',
        ]);
    });

    it('keeps dot commands as their own prompts', () => {
        expect(splitShareScript(core, catalog, 'select 1;\n  .output table  \nselect 2;\n.timer on')).toEqual([
            'select 1;',
            '.output table',
            'select 2;',
            '.timer on',
        ]);
    });

    it('slices statements after multi-byte characters', () => {
        expect(splitShareScript(core, catalog, 'select \'🦆\'; select \'ü\';')).toEqual([
            'select \'🦆\';',
            'select \'ü\';',
        ]);
    });

    it('keeps SQL that does not parse as a single prompt', () => {
        expect(splitShareScript(core, catalog, 'select from from; select 2;')).toEqual(['select from from; select 2;']);
    });

    it('ignores empty scripts', () => {
        expect(splitShareScript(core, catalog, ' \n\n ')).toEqual([]);
    });
});
