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
    it('external context collision', () => {
        const schemaScript = lnx!.createScript(1);
        schemaScript.insertTextAt(0, 'create table foo(a int);');
        schemaScript.scan().delete();
        schemaScript.parse().delete();
        schemaScript.analyze().delete();

        const mainScript = lnx!.createScript(1);
        mainScript.insertTextAt(0, 'select * from foo;');
        schemaScript.scan().delete();
        schemaScript.parse().delete();

        const searchPath = lnx!.createSchemaSearchPath();
        searchPath.pushScript(schemaScript);

        expect(() => {
            const analyzed = mainScript.analyze(searchPath);
            analyzed.delete();
        }).toThrow(new Error('Collision on external context identifier'));

        searchPath.delete();
        schemaScript.delete();
        mainScript.delete();
    });

    it(`external ref`, () => {
        const extScript = lnx!.createScript(1);
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

        const mainScript = lnx!.createScript(2);
        mainScript.insertTextAt(0, 'select * from foo');

        const searchPath = lnx!.createSchemaSearchPath();
        searchPath.pushScript(extScript);

        const mainScannerRes = mainScript.scan();
        const mainParserRes = mainScript.parse();
        const mainAnalyzerRes = mainScript.analyze(searchPath);

        const mainScanner = mainScannerRes.read(new sqlynx.proto.ScannedScript());
        const mainParser = mainParserRes.read(new sqlynx.proto.ParsedScript());
        const mainAnalyzer = mainAnalyzerRes.read(new sqlynx.proto.AnalyzedScript());
        expect(mainScanner.tokens()?.tokenTypesArray()?.length).toBeGreaterThan(0);
        expect(mainParser.nodesLength()).toBeGreaterThan(0);
        expect(mainAnalyzer.tableReferencesLength()).toEqual(1);

        const tableRef = mainAnalyzer.tableReferences(0);
        const tableName = tableRef?.tableName()!;
        expect(tableName.tableName()).toEqual('foo');

        searchPath.delete();

        extScannerRes.delete();
        extParserRes.delete();
        extAnalyzerRes.delete();

        mainScannerRes.delete();
        mainParserRes.delete();
        mainAnalyzerRes.delete();
    });
});
