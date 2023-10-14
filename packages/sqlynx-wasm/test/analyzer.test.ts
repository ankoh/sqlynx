import '@jest/globals';

import * as sqlynx from '../src';
import path from 'path';
import fs from 'fs';

const distPath = path.resolve(__dirname, '../dist');
const wasmPath = path.resolve(distPath, './sqlynx.wasm');

let fsql: sqlynx.SQLynx | null = null;

beforeAll(async () => {
    fsql = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(fsql).not.toBeNull();
});

describe('SQLynx Analyzer', () => {
    it('external context collision', () => {
        const schema_script = fsql!.createScript(1);
        schema_script.insertTextAt(0, 'create table foo(a int);');
        schema_script.scan().delete();
        schema_script.parse().delete();
        schema_script.analyze().delete();

        const main_script = fsql!.createScript(1);
        main_script.insertTextAt(0, 'select * from foo;');
        schema_script.scan().delete();
        schema_script.parse().delete();

        expect(() => {
            const analyzed = main_script.analyze(schema_script);
            analyzed.delete();
        }).toThrow(new Error('Collision on external context identifier'));

        schema_script.delete();
        main_script.delete();
    });

    it(`external ref`, () => {
        const ext_script = fsql!.createScript(1);
        ext_script.insertTextAt(0, 'create table foo(a int);');

        const ext_scanner_res = ext_script.scan();
        const ext_parser_res = ext_script.parse();
        const ext_analyzer_res = ext_script.analyze();

        const ext_scanner = ext_scanner_res.read(new sqlynx.proto.ScannedScript());
        const ext_parser = ext_parser_res.read(new sqlynx.proto.ParsedScript());
        const ext_analyzer = ext_analyzer_res.read(new sqlynx.proto.AnalyzedScript());
        expect(ext_scanner.tokens()?.tokenTypesArray()?.length).toBeGreaterThan(0);
        expect(ext_parser.nodesLength()).toBeGreaterThan(0);
        expect(ext_analyzer.tablesLength()).toEqual(1);

        const main_script = fsql!.createScript(2);
        main_script.insertTextAt(0, 'select * from foo');

        const main_scanner_res = main_script.scan();
        const main_parser_res = main_script.parse();
        const main_analyzer_res = main_script.analyze(ext_script);

        const main_scanner = main_scanner_res.read(new sqlynx.proto.ScannedScript());
        const main_parser = main_parser_res.read(new sqlynx.proto.ParsedScript());
        const main_analyzer = main_analyzer_res.read(new sqlynx.proto.AnalyzedScript());
        expect(main_scanner.tokens()?.tokenTypesArray()?.length).toBeGreaterThan(0);
        expect(main_parser.nodesLength()).toBeGreaterThan(0);
        expect(main_analyzer.tableReferencesLength()).toEqual(1);

        const table_ref = main_analyzer.tableReferences(0);
        const table_id = table_ref?.tableId()!;
        expect(sqlynx.QualifiedID.isNull(table_id)).not.toEqual(true);
        expect(sqlynx.QualifiedID.getContext(table_id)).toEqual(1);
        expect(sqlynx.QualifiedID.getIndex(table_id)).toEqual(0);

        ext_scanner_res.delete();
        ext_parser_res.delete();
        ext_analyzer_res.delete();

        main_scanner_res.delete();
        main_parser_res.delete();
        main_analyzer_res.delete();
    });
});
