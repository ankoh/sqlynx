import '@jest/globals';

import * as dashql from '@ankoh/dashql-core';

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { encodeCatalogAsProto } from './catalog_export.js';

const distPath = path.resolve(fileURLToPath(new URL('../../../dashql-core-bindings/dist', import.meta.url)));
const wasmPath = path.resolve(distPath, './dashql.wasm');

let lnx: dashql.DashQL | null = null;

beforeAll(async () => {
    lnx = await dashql.DashQL.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(lnx).not.toBeNull();
});

describe('Catalog Export', () => {
    it('can export example catalog', async () => {
        const catalog = lnx!.createCatalog();
        catalog.addDescriptorPool(1, 10);
        catalog.addSchemaDescriptorT(
            1,
            new dashql.buffers.SchemaDescriptorT('db1', 'schema1', [
                new dashql.buffers.SchemaTableT(0, 'table1', [
                    new dashql.buffers.SchemaTableColumnT('column1'),
                    new dashql.buffers.SchemaTableColumnT('column2'),
                    new dashql.buffers.SchemaTableColumnT('column3'),
                ]),
                new dashql.buffers.SchemaTableT(0, 'table2', [
                    new dashql.buffers.SchemaTableColumnT('column1'),
                    new dashql.buffers.SchemaTableColumnT('column2'),
                    new dashql.buffers.SchemaTableColumnT('column3'),
                ]),
            ])
        );
        catalog.addSchemaDescriptorT(
            1,
            new dashql.buffers.SchemaDescriptorT('db1', 'schema2', [
                new dashql.buffers.SchemaTableT(0, 'table1', [
                    new dashql.buffers.SchemaTableColumnT('column1'),
                    new dashql.buffers.SchemaTableColumnT('column2'),
                    new dashql.buffers.SchemaTableColumnT('column3'),
                ]),
            ]),
        );

        const snap = catalog.createSnapshot();
        const proto = encodeCatalogAsProto(snap);

        expect(proto.databases.length).toEqual(1);
        expect(proto.databases[0].schemas.length).toEqual(2);
        expect(proto.databases[0].schemas[0].tables.length).toEqual(2);
        expect(proto.databases[0].schemas[0].tables[0].columns.length).toEqual(3);
        expect(proto.databases[0].schemas[0].tables[1].columns.length).toEqual(3);
        expect(proto.databases[0].schemas[1].tables.length).toEqual(1);
        expect(proto.databases[0].schemas[1].tables[0].columns.length).toEqual(3);

        catalog.delete();
    });
});

