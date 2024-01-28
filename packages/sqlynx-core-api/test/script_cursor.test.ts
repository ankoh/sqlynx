import '@jest/globals';

import * as sqlynx from '../src';
import path from 'path';
import fs from 'fs';
import { ScriptCursorInfo } from '../gen/sqlynx/proto';

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

interface ExpectedCursor {
    scannerTokenText: string;
    statementId: number;
    astAttributeKey: sqlynx.proto.AttributeKey;
    astNodeType: sqlynx.proto.NodeType;
    tableRefName: string | null;
    columnRefName: string | null;
    graphFrom: string[] | null;
    graphTo: string[] | null;
}

describe('SQLynx Cursor', () => {
    it('simple script', () => {
        const scriptText = 'select * from A b, C d where b.x = d.y';
        const script = lnx!.createScript(null, 1);
        script.insertTextAt(0, scriptText);

        const scannedBuffer = script.scan();
        const parsedBuffer = script.parse();
        const analyzedBuffer = script.analyze();
        const scanned = scannedBuffer.read(new sqlynx.proto.ScannedScript());
        const parsed = parsedBuffer.read(new sqlynx.proto.ParsedScript());
        const tmpCursor = new sqlynx.proto.ScriptCursorInfo();

        const scannerTokens = scanned.tokens()!;
        expect(scannerTokens).not.toBeNull();
        const scannerTokenOffsets = scannerTokens.tokenOffsetsArray()!;
        const scannerTokenLengths = scannerTokens.tokenLengthsArray()!;

        const test = (script: sqlynx.SQLynxScript, offset: number, expected: ExpectedCursor) => {
            const cursorBuffer = script.moveCursor(0);
            const cursor = cursorBuffer.read(tmpCursor);

            expect(cursor.textOffset()).toEqual(offset);
            const node = parsed.nodes(cursor.astNodeId())!;

            expect(node.attributeKey()).toEqual(expected.astAttributeKey);
            expect(node.nodeType()).toEqual(expected.astNodeType);
            const tokenOffset = scannerTokenOffsets[cursor.scannerSymbolId()];
            const tokenLength = scannerTokenLengths[cursor.scannerSymbolId()];
            expect(scriptText.substring(tokenOffset, tokenOffset + tokenLength)).toEqual('select');

            cursorBuffer.delete();
            analyzedBuffer.delete();
            parsedBuffer.delete();
            scannedBuffer.delete();
        };

        test(script, 0, {
            scannerTokenText: 'select',
            statementId: 0,
            astAttributeKey: sqlynx.proto.AttributeKey.NONE,
            astNodeType: sqlynx.proto.NodeType.OBJECT_SQL_SELECT,
            tableRefName: null,
            columnRefName: null,
            graphFrom: null,
            graphTo: null,
        });
    });
});
