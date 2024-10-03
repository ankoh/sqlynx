import '@jest/globals';

import * as sqlynx from '@ankoh/sqlynx-core';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { CatalogRenderingSettings, CatalogViewModel } from './catalog_view_model.js';

const coreDistPath = path.resolve(fileURLToPath(new URL('../../../../sqlynx-core-bindings/dist', import.meta.url)));
const wasmPath = path.resolve(coreDistPath, './sqlynx.wasm');

let lnx: sqlynx.SQLynx | null = null;

beforeAll(async () => {
    lnx = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(lnx).not.toBeNull();
});

const DEFAULT_RENDERING_SETTINGS: CatalogRenderingSettings = {
    virtual: {
        prerenderSize: 200,
        stepSize: 1,
    },
    levels: {
        databases: {
            nodeWidth: 160,
            nodeHeight: 30,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
        schemas: {
            nodeWidth: 160,
            nodeHeight: 30,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
        tables: {
            nodeWidth: 160,
            nodeHeight: 30,
            maxUnpinnedChildren: 5,
            rowGap: 16,
            columnGap: 48,
        },
        columns: {
            nodeWidth: 160,
            nodeHeight: 30,
            maxUnpinnedChildren: 3,
            rowGap: 8,
            columnGap: 48,
        },
    }
};

describe('CatalogViewModel', () => {
    it('2 tables', () => {
        const catalog = lnx!.createCatalog();
        const schemaText = `
            CREATE TABLE table1 (
                col1 integer,
                col2 integer,
                col3 integer,
                col4 integer,
                col5 integer,
                col6 integer
            );
            CREATE TABLE table2 (
                col1 integer,
                col2 integer,
                col3 integer,
                col4 integer,
                col5 integer,
                col6 integer
            );
        `;
        const schemaScript = lnx!.createScript(catalog, 1);
        schemaScript.insertTextAt(0, schemaText);
        schemaScript.scan(true).delete();
        schemaScript.parse(true).delete();
        schemaScript.analyze().delete();
        catalog.loadScript(schemaScript, 1);

        const snapshotPtr = catalog.createSnapshot();
        const snapshot = snapshotPtr.read();
        expect(snapshot.catalogReader.databasesLength()).toEqual(1);
        expect(snapshot.catalogReader.schemasLength()).toEqual(1);
        expect(snapshot.catalogReader.tablesLength()).toEqual(2);
        expect(snapshot.catalogReader.columnsLength()).toEqual(12);

        const catalogVM = new CatalogViewModel(snapshotPtr, DEFAULT_RENDERING_SETTINGS);
        catalogVM.layoutEntries();
        expect(catalogVM.totalHeight).toEqual(
            // 2 times 3 tables with overflow node
            2 * ((3 + 1) * DEFAULT_RENDERING_SETTINGS.levels.columns.nodeHeight +
                (2 + 1) * DEFAULT_RENDERING_SETTINGS.levels.columns.rowGap) +
            // Row gap between tables
            1 * DEFAULT_RENDERING_SETTINGS.levels.tables.rowGap
        );

        const queryText = `
            select col4 from table1;
        `;
        const queryScript = lnx!.createScript(catalog, 2);
        queryScript.insertTextAt(0, queryText);
        queryScript.scan(true).delete();
        queryScript.parse(true).delete();
        const analyzed = queryScript.analyze();
        const analyzedReader = analyzed.read();
        expect(analyzedReader.tableReferencesLength()).toEqual(1);
        expect(analyzedReader.expressionsLength()).toEqual(1);

        catalogVM.pinScriptRefs(analyzedReader);
        expect(catalogVM.totalHeight).toEqual(
            // 2 times 3 tables with overflow node
            2 * ((3 + 1) * DEFAULT_RENDERING_SETTINGS.levels.columns.nodeHeight +
                (2 + 1) * DEFAULT_RENDERING_SETTINGS.levels.columns.rowGap) +
            // Row gap between tables
            1 * DEFAULT_RENDERING_SETTINGS.levels.tables.rowGap +
            // Newly pinned element
            DEFAULT_RENDERING_SETTINGS.levels.columns.nodeHeight +
            DEFAULT_RENDERING_SETTINGS.levels.columns.rowGap
        );
    });
});
