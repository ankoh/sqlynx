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
    it('clear catalog', () => {
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
        let descriptionBuffer = catalog.describeEntries();
        let description = descriptionBuffer.read(new sqlynx.proto.CatalogEntries());
        expect(description.entriesLength()).toEqual(1);
        descriptionBuffer.delete();

        descriptionBuffer = catalog.describeEntriesOf(1);
        description = descriptionBuffer.read(new sqlynx.proto.CatalogEntries());
        expect(description.entriesLength()).toEqual(1);
        descriptionBuffer.delete();

        catalog.clear();

        descriptionBuffer = catalog.describeEntries();
        description = descriptionBuffer.read(new sqlynx.proto.CatalogEntries());
        expect(description.entriesLength()).toEqual(0);
        descriptionBuffer.delete();
    });

    it('dynamic registration', () => {
        const catalog = lnx!.createCatalog();
        catalog.addDescriptorPool(1, 10);

        // Create and analyze a script referencing an unknown table
        const script = lnx!.createScript(catalog, 2);
        script.replaceText('select * from db1.schema1.table1');
        script.scan().delete();
        script.parse().delete();
        let analyzedBuffer = script.analyze();
        let analyzed = analyzedBuffer.read(new sqlynx.proto.AnalyzedScript());
        expect(analyzed.tableReferencesLength()).toEqual(1);

        // The analyzed script contains an unresolved table ref
        const tableRef = analyzed.tableReferences(0)!;
        let resolved = tableRef.resolvedTableId();
        expect(sqlynx.ExternalObjectID.isNull(resolved)).toBeTruthy();

        // Check the table name
        const tableName = tableRef.tableName(new sqlynx.proto.QualifiedTableName())!;
        expect(tableName.databaseName()).toEqual('db1');
        expect(tableName.schemaName()).toEqual('schema1');
        expect(tableName.tableName()).toEqual('table1');
        analyzedBuffer.delete();

        // Resolve the table declaration and add a schema descriptor to the descriptor pool
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

        // Now analyze the script again
        script.parse().delete();
        analyzedBuffer = script.analyze();
        analyzed = analyzedBuffer.read(new sqlynx.proto.AnalyzedScript());
        expect(analyzed.tableReferencesLength()).toEqual(1);
        resolved = tableRef.resolvedTableId();
        expect(sqlynx.ExternalObjectID.isNull(resolved)).toBeFalsy();

        // Delete all the memory
        analyzedBuffer.delete();
        script.delete();
        catalog.delete();
    });
});
