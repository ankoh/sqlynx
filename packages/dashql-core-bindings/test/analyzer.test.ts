import '@jest/globals';

import * as dashql from '../src/index.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';

const distPath = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const wasmPath = path.resolve(distPath, './dashql.wasm');

let lnx: dashql.DashQL | null = null;

beforeAll(async () => {
    lnx = await dashql.DashQL.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(lnx).not.toBeNull();
});

describe('DashQL Analyzer', () => {
    it('external identifier collision', () => {
        const catalog = lnx!.createCatalog();
        const schemaScript = lnx!.createScript(catalog, 1);
        schemaScript.insertTextAt(0, 'create table foo(a int);');
        schemaScript.scan().delete();
        schemaScript.parse().delete();
        schemaScript.analyze().delete();

        catalog.loadScript(schemaScript, 0);

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
        const catalog = lnx!.createCatalog();
        const extScript = lnx!.createScript(catalog, 1);
        extScript.insertTextAt(0, 'create table foo(a int);');

        const extScannerRes = extScript.scan();
        const extParserRes = extScript.parse();
        const extAnalyzerRes = extScript.analyze();

        const extScanner = extScannerRes.read();
        const extParser = extParserRes.read();
        const extAnalyzer = extAnalyzerRes.read();
        expect(extScanner.tokens()?.tokenTypesArray()?.length).toBeGreaterThan(0);
        expect(extParser.nodesLength()).toBeGreaterThan(0);
        expect(extAnalyzer.tablesLength()).toEqual(1);

        catalog.loadScript(extScript, 0);

        const mainScript = lnx!.createScript(catalog, 2);
        mainScript.insertTextAt(0, 'select * from foo');

        const mainScannerRes = mainScript.scan();
        const mainParserRes = mainScript.parse();
        const mainAnalyzerRes = mainScript.analyze();

        const mainScanner = mainScannerRes.read();
        const mainParser = mainParserRes.read();
        const mainAnalyzer = mainAnalyzerRes.read();
        expect(mainScanner.tokens()?.tokenTypesArray()?.length).toBeGreaterThan(0);
        expect(mainParser.nodesLength()).toBeGreaterThan(0);
        expect(mainAnalyzer.tableReferencesLength()).toEqual(1);

        const tableRef = mainAnalyzer.tableReferences(0)!;
        expect(tableRef.innerType()).toEqual(dashql.buffers.TableReferenceSubType.ResolvedRelationExpression);
        const resolved = tableRef.inner(new dashql.buffers.ResolvedRelationExpression()) as dashql.buffers.ResolvedRelationExpression;
        expect(resolved.tableName()!.tableName()!).toEqual('foo');

        mainScannerRes.delete();
        mainParserRes.delete();
        mainAnalyzerRes.delete();

        catalog.delete();

        extScannerRes.delete();
        extParserRes.delete();
        extAnalyzerRes.delete();
    });
});
