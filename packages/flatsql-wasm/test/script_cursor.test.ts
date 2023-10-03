import '@jest/globals';

import * as flatsql from '../src';
import path from 'path';
import fs from 'fs';
import { ScriptCursorInfo } from '../gen/flatsql/proto';

const distPath = path.resolve(__dirname, '../dist');
const wasmPath = path.resolve(distPath, './flatsql.wasm');

let fsql: flatsql.FlatSQL | null = null;

beforeAll(async () => {
    fsql = await flatsql.FlatSQL.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(fsql).not.toBeNull();
});

interface ExpectedCursor {
    scannerTokenText: string;
    statementId: number;
    astAttributeKey: flatsql.proto.AttributeKey;
    astNodeType: flatsql.proto.NodeType;
    tableRefName: string | null;
    columnRefName: string | null;
    graphFrom: string[] | null;
    graphTo: string[] | null;
}

describe('FlatSQL Cursor', () => {
    it('simple script', () => {
        const scriptText = 'select * from A b, C d where b.x = d.y';
        const script = fsql!.createScript(1);
        script.insertTextAt(0, scriptText);

        const scannedBuffer = script.scan();
        const parsedBuffer = script.parse();
        const analyzedBuffer = script.analyze();
        const scanned = scannedBuffer.read(new flatsql.proto.ScannedScript());
        const parsed = parsedBuffer.read(new flatsql.proto.ParsedScript());
        const tmpCursor = new flatsql.proto.ScriptCursorInfo();

        const scannerTokens = scanned.tokens()!;
        expect(scannerTokens).not.toBeNull();
        const scannerTokenOffsets = scannerTokens.tokenOffsetsArray()!;
        const scannerTokenLengths = scannerTokens.tokenLengthsArray()!;

        const test = (script: flatsql.FlatSQLScript, offset: number, expected: ExpectedCursor) => {
            const cursorBuffer = script.moveCursor(0);
            const cursor = cursorBuffer.read(tmpCursor);

            expect(cursor.textOffset()).toEqual(offset);
            const node = parsed.nodes(cursor.astNodeId())!;

            expect(node.attributeKey()).toEqual(expected.astAttributeKey);
            expect(node.nodeType()).toEqual(expected.astNodeType);
            const tokenOffset = scannerTokenOffsets[cursor.scannerTokenId()];
            const tokenLength = scannerTokenLengths[cursor.scannerTokenId()];
            expect(scriptText.substring(tokenOffset, tokenOffset + tokenLength)).toEqual('select');

            cursorBuffer.delete();
            analyzedBuffer.delete();
            parsedBuffer.delete();
            scannedBuffer.delete();
        };

        test(script, 0, {
            scannerTokenText: 'select',
            statementId: 0,
            astAttributeKey: flatsql.proto.AttributeKey.NONE,
            astNodeType: flatsql.proto.NodeType.OBJECT_SQL_SELECT,
            tableRefName: null,
            columnRefName: null,
            graphFrom: null,
            graphTo: null,
        });
    });
});
