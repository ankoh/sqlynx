import * as dashql from './index.js';

import { loadCoreWasm } from './test_fixture.js';

let dql: dashql.DashQL | null = null;
beforeAll(async () => {
    const wasmBinary = await loadCoreWasm();
    dql = await dashql.DashQL.create({ wasmBinary });
    expect(dql).not.toBeNull();
});
afterEach(async () => {
    dql!.resetUnsafe();
});

interface ExpectedCursor {
    scannerTokenText: string;
    statementId: number;
    astAttributeKey: dashql.buffers.parser.AttributeKey;
    astNodeType: dashql.buffers.parser.NodeType;
    tableRefName: string | null;
    columnRefName: string | null;
    graphFrom: string[] | null;
    graphTo: string[] | null;
}

describe('DashQL Cursor', () => {
    it('simple script', () => {
        const catalog = dql!.createCatalog();
        const scriptText = 'select * from A b, C d where b.x = d.y';
        const script = dql!.createScript(catalog);
        script.insertTextAt(0, scriptText);
        script.analyze();

        const parsedBuffer = script.getParsed();
        const analyzedBuffer = script.getAnalyzed();
        const parsed = parsedBuffer.read();
        const tmpCursor = new dashql.buffers.cursor.ScriptCursor();

        const scannerTokens = parsed.tokens()!;
        expect(scannerTokens).not.toBeNull();
        const scannerTokenOffsets = scannerTokens.tokenOffsetsArray()!;
        const scannerTokenLengths = scannerTokens.tokenLengthsArray()!;

        const test = (script: dashql.DashQLScript, offset: number, expected: ExpectedCursor) => {
            const cursorBuffer = script.moveCursor(0);
            const cursor = cursorBuffer.read(tmpCursor);

            expect(cursor.textOffset()).toEqual(offset);
            const node = parsed.nodes(cursor.astNodeId())!;

            expect(node.attributeKey()).toEqual(expected.astAttributeKey);
            expect(node.nodeType()).toEqual(expected.astNodeType);
            const tokenOffset = scannerTokenOffsets[cursor.scannerSymbolId()];
            const tokenLength = scannerTokenLengths[cursor.scannerSymbolId()];
            expect(scriptText.substring(tokenOffset, tokenOffset + tokenLength)).toEqual('select');

            cursorBuffer.destroy();
            analyzedBuffer.destroy();
            parsedBuffer.destroy();
        };

        test(script, 0, {
            scannerTokenText: 'select',
            statementId: 0,
            astAttributeKey: dashql.buffers.parser.AttributeKey.NONE,
            astNodeType: dashql.buffers.parser.NodeType.OBJECT_SQL_SELECT,
            tableRefName: null,
            columnRefName: null,
            graphFrom: null,
            graphTo: null,
        });
    });
});
