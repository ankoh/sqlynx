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

describe('SQLynx Analyzer', () => {
    it('external identifier collision', () => {
        const schemaScript = lnx!.createScript(null, 1);
        schemaScript.insertTextAt(0, 'create table foo(a int);');
        schemaScript.scan().delete();
        schemaScript.parse().delete();
        schemaScript.analyze().delete();

        const catalog = lnx!.createCatalog();
        catalog.addScript(schemaScript, 0);

        expect(() => {
            const mainScript = lnx!.createScript(catalog, 1);
            mainScript.insertTextAt(0, 'select * from foo;');
            mainScript.scan().delete();
            mainScript.parse().delete();
            mainScript.analyze().delete();
            mainScript.delete();
        }).toThrow(new Error('Collision on external identifier'));

        catalog.delete();
        schemaScript.delete();
    });

    it(`external ref`, () => {
        const extScript = lnx!.createScript(null, 1);
        extScript.insertTextAt(0, 'create table foo(a int);');

        const extScannerRes = extScript.scan();
        const extParserRes = extScript.parse();
        const extAnalyzerRes = extScript.analyze();

        const extScanner = extScannerRes.read(new sqlynx.proto.ScannedScript());
        const extParser = extParserRes.read(new sqlynx.proto.ParsedScript());
        const extAnalyzer = extAnalyzerRes.read(new sqlynx.proto.AnalyzedScript());
        expect(extScanner.tokens()?.tokenTypesArray()?.length).toBeGreaterThan(0);
        expect(extParser.nodesLength()).toBeGreaterThan(0);
        expect(extAnalyzer.tablesLength()).toEqual(1);

        const catalog = lnx!.createCatalog();
        catalog.addScript(extScript, 0);

        const mainScript = lnx!.createScript(catalog, 2);
        mainScript.insertTextAt(0, 'select * from foo');

        const mainScannerRes = mainScript.scan();
        const mainParserRes = mainScript.parse();
        const mainAnalyzerRes = mainScript.analyze();

        const mainScanner = mainScannerRes.read(new sqlynx.proto.ScannedScript());
        const mainParser = mainParserRes.read(new sqlynx.proto.ParsedScript());
        const mainAnalyzer = mainAnalyzerRes.read(new sqlynx.proto.AnalyzedScript());
        expect(mainScanner.tokens()?.tokenTypesArray()?.length).toBeGreaterThan(0);
        expect(mainParser.nodesLength()).toBeGreaterThan(0);
        expect(mainAnalyzer.tableReferencesLength()).toEqual(1);

        const tableRef = mainAnalyzer.tableReferences(0);
        const tableName = tableRef?.tableName()!;
        expect(tableName.tableName()).toEqual('foo');

        mainScannerRes.delete();
        mainParserRes.delete();
        mainAnalyzerRes.delete();

        catalog.delete();

        extScannerRes.delete();
        extParserRes.delete();
        extAnalyzerRes.delete();
    });
});
