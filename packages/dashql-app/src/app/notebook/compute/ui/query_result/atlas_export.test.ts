import * as arrow from 'apache-arrow';
import * as dashql from '@ankoh/dashql-core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
    applyMetadata,
    buildAtlasExport,
    coreMetadataBlockFinder,
    metadataValue,
    rowFileName,
    type MetadataBlockFinder,
} from './atlas_export.js';

const encoder = new TextEncoder();

let core: dashql.DashQL;
let findBlock: MetadataBlockFinder;
beforeAll(async () => {
    core = await dashql.DashQL.create();
    findBlock = coreMetadataBlockFinder(core);
}, 60_000);

function readBack(text: string): dashql.ScriptMetadata | null {
    const catalog = core.createCatalog();
    const script = core.createScript(catalog);
    try {
        script.insertTextAt(0, text);
        script.parse();
        const parsed = script.getParsed();
        try {
            return dashql.readMetadata(parsed.read(), encoder.encode(text));
        } finally {
            parsed.destroy();
        }
    } finally {
        script.destroy();
        catalog.destroy();
    }
}

describe('atlas export', () => {
    it('names files after the row number', () => {
        expect(rowFileName(0, 3)).toBe('row_00001.sql');
        expect(rowFileName(41, 100)).toBe('row_00042.sql');
        expect(rowFileName(0, 123456)).toBe('row_000001.sql');
    });

    it('converts cells to JSON values', () => {
        const formatted = () => '2026-10-18';
        expect(metadataValue(null, new arrow.Utf8(), formatted)).toBeUndefined();
        expect(metadataValue('x', new arrow.Utf8(), formatted)).toBe('x');
        expect(metadataValue(42n, new arrow.Int64(), formatted)).toBe(42);
        expect(metadataValue(2n ** 60n, new arrow.Int64(), formatted)).toBe('1152921504606846976');
        expect(metadataValue(NaN, new arrow.Float64(), formatted)).toBe('NaN');
        expect(metadataValue(true, new arrow.Bool(), formatted)).toBe(true);
        expect(metadataValue(1760745600000, new arrow.DateMillisecond(), formatted)).toBe('2026-10-18');
    });

    it('puts the metadata above the script and replaces existing metadata', () => {
        const sql = '-- @dashql:description\n-- Revenue.\n-- @dashql:end\nselect 1;\n';
        const once = applyMetadata(sql, { owner: 'finance' }, findBlock);
        expect(once).toBe(`${dashql.renderMetadataBlock({ owner: 'finance' })}\n\n${sql}`);
        expect(readBack(once)).toEqual({ owner: 'finance' });
        // Exporting again replaces the block, also an invalid one, and keeps the description
        const twice = applyMetadata(once, { owner: 'sales' }, findBlock);
        expect(twice).toBe(`${dashql.renderMetadataBlock({ owner: 'sales' })}\n\n${sql}`);
        const invalid = '-- @dashql:metadata\n-- owner: x\n-- @dashql:end\n\nselect 1;\n';
        expect(applyMetadata(invalid, { owner: 'sales' }, findBlock)).toBe(
            `${dashql.renderMetadataBlock({ owner: 'sales' })}\n\nselect 1;\n`,
        );
        // CRLF scripts get CRLF blocks
        expect(applyMetadata('select 1;\r\n', { a: 1 }, findBlock)).toBe(
            `${dashql.renderMetadataBlock({ a: 1 }, '\r\n')}\r\n\r\nselect 1;\r\n`,
        );
    });

    it('builds a script per row', () => {
        const utf8 = (values: (string | null)[]) => {
            const builder = arrow.makeBuilder({ type: new arrow.Utf8(), nullValues: [null] });
            values.forEach(v => builder.append(v));
            return builder.finish().toVector();
        };
        const table = new arrow.Table({
            sql: utf8(['select 1;', null, 'select 2;']),
            owner: utf8(['finance', 'sales', null]),
        });
        const result = buildAtlasExport(
            table,
            { sqlField: 0, metadataFields: [1] },
            (row, field) => String(table.getChildAt(field)!.get(row)),
            findBlock,
        );
        expect(result.skipped).toBe(1);
        expect(result.files.map(f => f.name)).toEqual(['row_00001.sql', 'row_00003.sql']);
        expect(readBack(result.files[0].text)).toEqual({ owner: 'finance' });
        // Nulls are left out
        expect(readBack(result.files[1].text)).toEqual({});
        expect(result.files[1].text.endsWith('select 2;')).toBe(true);
    });
});
