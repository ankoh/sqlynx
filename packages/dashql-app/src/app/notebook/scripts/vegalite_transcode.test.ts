import * as core from '@ankoh/dashql-core';

import { verifyScript } from './scratch_script_verify.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: core.DashQL | null = null;
beforeAll(async () => {
    const wasmBinary = await DASHQL_PRECOMPILED;
    dql = await core.DashQL.create({ wasmBinary });
    expect(dql).not.toBeNull();
});
afterEach(() => {
    dql!.resetUnsafe();
});

/// Transcode a spec object via the WASM core, injecting an inline source as the `data` member.
function transcode(spec: Record<string, unknown>, source: { kind: 'inline-select'; sql: string } = INLINE_SOURCE): string {
    const data = { $sql: source.sql.trim() };
    return dql!.parseVegaLiteToVisualize(JSON.stringify({ ...spec, data }));
}

const INLINE_SOURCE = { kind: 'inline-select' as const, sql: 'SELECT * FROM sales' };

describe('parseVegaLiteToVisualize (WASM)', () => {
    it('rejects a named data source without query text', () => {
        const dsl = dql!.parseVegaLiteToVisualize(JSON.stringify({
            data: { name: 'sales' },
            mark: 'bar',
        }));
        expect(dsl).toBe('');
    });

    it('emits a $sql data source before the trailing visualization clause', () => {
        const dsl = dql!.parseVegaLiteToVisualize(JSON.stringify({
            data: { $sql: 'SELECT a FROM t' },
            mark: 'bar',
        }));
        expect(dsl).toContain('SELECT a FROM t\nVISUALIZE USING vegalite');
    });

    it('returns an empty string when data is missing', () => {
        expect(dql!.parseVegaLiteToVisualize(JSON.stringify({ mark: 'bar' }))).toBe('');
    });

    it('emits a minimal bar chart', () => {
        const dsl = transcode(
            {
                mark: 'bar',
                encoding: {
                    x: { field: 'category', type: 'nominal' },
                    y: { field: 'amount', type: 'quantitative' },
                },
            },
        );
        expect(dsl).toContain('SELECT * FROM sales\nVISUALIZE USING vegalite');
        expect(dsl).toContain('mark => bar');
        expect(dsl).toContain('x => (field => category, type => nominal)');
        expect(dsl).toContain('y => (field => amount, type => quantitative)');
    });

    it('accepts an object-form mark', () => {
        const dsl = transcode(
            { mark: { type: 'line' }, encoding: { x: { field: 'ts', type: 'temporal' } } },
        );
        expect(dsl).toContain('mark => line');
    });

    it('single-quotes strings, keeps supported values bare, and drops renderer dimensions', () => {
        const dsl = transcode(
            {
                mark: 'bar',
                title: 'My Chart',
                width: 320,
                encoding: {
                    x: {
                        field: 'category',
                        type: 'nominal',
                        axis: { labelAngle: -45, format: '%Y' },
                        scale: { zero: false },
                    },
                },
            },
        );
        expect(dsl).toContain("title => 'My Chart'");
        expect(dsl).not.toContain('width => 320');
        expect(dsl).toContain('label_angle => -45');
        expect(dsl).toContain("format => '%Y'");
        expect(dsl).toContain('zero => false');
    });

    it('maps camelCase keys to snake_case DSL keys', () => {
        const dsl = transcode(
            {
                mark: 'point',
                encoding: {
                    x: { field: 'ts', type: 'temporal', timeUnit: 'month' },
                    fillOpacity: { field: 'w', type: 'quantitative' },
                    y: { field: 'v', type: 'quantitative', scale: { type: 'log', paddingInner: 0.2 } },
                },
            },
        );
        expect(dsl).toContain('time_unit => month');
        expect(dsl).toContain('fill_opacity =>');
        expect(dsl).toContain('scale => (type => log, padding_inner => 0.2)');
    });

    it('emits bin as a bare boolean or a param object', () => {
        const boolBin = transcode(
            { mark: 'bar', encoding: { x: { field: 'a', type: 'quantitative', bin: true } } },
        );
        expect(boolBin).toContain('bin => true');

        const objBin = transcode(
            { mark: 'bar', encoding: { x: { field: 'a', type: 'quantitative', bin: { maxbins: 10 } } } },
        );
        expect(objBin).toContain('bin => (maxbins => 10)');
    });

    it('emits arrays bare with quoted string elements', () => {
        const dsl = transcode(
            {
                mark: 'bar',
                encoding: {
                    y: { field: 'v', type: 'quantitative', scale: { domain: [0, 100] } },
                    color: { field: 'c', type: 'nominal', scale: { domain: ['a', 'b'] } },
                },
            },
        );
        expect(dsl).toContain('domain => [0, 100]');
        expect(dsl).toContain("domain => ['a', 'b']");
    });

    it('emits layered specs and resolve settings', () => {
        const dsl = transcode({
            encoding: {
                x: { field: 'date', type: 'temporal' },
            },
            layer: [
                { mark: 'line', encoding: { y: { field: 'amount', type: 'quantitative' } } },
                { mark: 'point', encoding: { y: { field: 'target', type: 'quantitative' } } },
            ],
            resolve: {
                scale: { y: 'independent' },
                axis: { y: 'independent' },
                legend: { color: 'shared' },
            },
        });
        expect(dsl).toContain('layer => [');
        expect(dsl).toContain('mark => line');
        expect(dsl).toContain('mark => point');
        expect(dsl).toContain('resolve => (scale => (y => independent), axis => (y => independent), legend => (color => shared))');
    });

    it('drops unsupported keys and unknown channels', () => {
        const dsl = transcode(
            {
                mark: 'bar',
                config: { background: 'red' },
                encoding: {
                    x: { field: 'a', type: 'nominal', unknownProp: 1 },
                    bogusChannel: { field: 'b', type: 'nominal' },
                },
            },
        );
        expect(dsl).not.toContain('config');
        expect(dsl).not.toContain('unknownProp');
        expect(dsl).not.toContain('bogusChannel');
    });

    it('quotes non-simple field identifiers', () => {
        const dsl = transcode(
            { mark: 'bar', encoding: { x: { field: 'has space', type: 'nominal' } } },
        );
        expect(dsl).toContain('field => "has space"');
    });

    it('emits an inline-select source', () => {
        const dsl = transcode(
            { mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' } } },
            { kind: 'inline-select', sql: 'SELECT a FROM t' },
        );
        expect(dsl).toContain('SELECT a FROM t\nVISUALIZE USING vegalite');
    });

    it('returns an empty string for malformed JSON', () => {
        expect(dql!.parseVegaLiteToVisualize('not json')).toBe('');
    });
});

/// Parse + analyze the transcoded DSL against a catalog seeded with the given source table,
/// using the scratch-script verifier.
function verifyAgainstSource(sourceSql: string, visText: string) {
    const catalog = dql!.createCatalog();
    const sourceScript = dql!.createScript(catalog);
    try {
        sourceScript.replaceText(sourceSql);
        sourceScript.analyze();
        catalog.loadScript(sourceScript, 0);
        return verifyScript(dql!, catalog, visText);
    } finally {
        sourceScript.destroy();
        catalog.destroy();
    }
}

describe('parseVegaLiteToVisualize round-trip', () => {
    it('produces DSL that parses + analyzes cleanly against an inline select', () => {
        const dsl = transcode(
            {
                mark: 'bar',
                encoding: {
                    x: { field: 'category', type: 'nominal' },
                    y: { field: 'amount', type: 'quantitative', aggregate: 'sum' },
                },
            },
            { kind: 'inline-select', sql: 'SELECT * FROM sales' },
        );
        const r = verifyAgainstSource('create table sales(category text, amount int);', dsl);
        expect(r.parserErrors).toEqual([]);
        expect(r.analyzerErrors).toEqual([]);
        expect(r.visualizationSpecs).toBeGreaterThan(0);
    });

    it('produces DSL with scale/axis/title that parses + analyzes cleanly', () => {
        const dsl = transcode(
            {
                mark: 'line',
                title: 'Revenue',
                width: 400,
                height: 200,
                encoding: {
                    x: { field: 'ts', type: 'temporal', timeUnit: 'month', axis: { labelAngle: -45 } },
                    y: { field: 'amount', type: 'quantitative', scale: { type: 'linear', zero: false } },
                },
            },
            { kind: 'inline-select', sql: 'SELECT * FROM sales' },
        );
        const r = verifyAgainstSource('create table sales(ts timestamp, amount int);', dsl);
        expect(r.parserErrors).toEqual([]);
        expect(r.analyzerErrors).toEqual([]);
        expect(r.visualizationSpecs).toBeGreaterThan(0);
    });

    it('produces layered DSL with resolve that parses + analyzes cleanly', () => {
        const dsl = transcode({
            encoding: { x: { field: 'date', type: 'temporal' } },
            layer: [
                { mark: 'line', encoding: { y: { field: 'amount', type: 'quantitative' } } },
                { mark: 'point', encoding: { y: { field: 'target', type: 'quantitative' } } },
            ],
            resolve: { scale: { y: 'independent' } },
        });
        const r = verifyAgainstSource('create table sales(date timestamp, amount int, target int);', dsl);
        expect(r.parserErrors).toEqual([]);
        expect(r.analyzerErrors).toEqual([]);
        expect(r.visualizationSpecs).toBeGreaterThan(0);
    });
});
