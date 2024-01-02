import '@jest/globals';

import * as sqlynx from '../src';
import path from 'path';
import fs from 'fs';

const distPath = path.resolve(__dirname, '../dist');
const wasmPath = path.resolve(distPath, './sqlynx.wasm');

let lnx: sqlynx.SQLynx | null = null;

beforeAll(async () => {
    lnx = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(lnx).not.toBeNull();
});

describe('Catalog Tests ', () => {
    it('add schema descriptor', () => {
        const catalog = lnx!.createCatalog();
        catalog.addDescriptorPool(1, 10);
        catalog.addSchemaDescriptorT(
            1,
            new sqlynx.proto.SchemaDescriptorT('db1', 'schema1', [
                new sqlynx.proto.SchemaTableT('table1', [
                    new sqlynx.proto.SchemaTableColumnT('column1'),
                    new sqlynx.proto.SchemaTableColumnT('column2'),
                    new sqlynx.proto.SchemaTableColumnT('column3'),
                ]),
            ]),
        );
        const description = catalog.describeEntries();
        const catalogEntries = description.read(new sqlynx.proto.CatalogEntries()).unpack();
        expect(catalogEntries.entries.length).toEqual(1);
        expect(catalogEntries.entries[0].externalId).toEqual(1);
        expect(catalogEntries.entries[0].entryType).toEqual(sqlynx.proto.CatalogEntryType.DESCRIPTOR_POOL);
        expect(catalogEntries.entries[0].rank).toEqual(10);

        const script = lnx!.createScript(catalog, 2);
        script.replaceText('select * from db1.schema1.table1');
        script.scan().delete();
        script.parse().delete();
        const analyzed = script.analyze().read(new sqlynx.proto.AnalyzedScript());
        expect(analyzed.tableReferencesLength()).toEqual(1);

        const tableRef = analyzed.tableReferences(0)!;
        const resovledTableId = tableRef.resolvedTableId();
        expect(sqlynx.ExternalObjectID.isNull(resovledTableId)).toBeFalsy();
        expect(sqlynx.ExternalObjectID.getExternalID(resovledTableId)).toEqual(1);
        expect(sqlynx.ExternalObjectID.getObjectID(resovledTableId)).toEqual(0);

        script.delete();
        catalog.delete();
    });
});
