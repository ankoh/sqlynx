import '@jest/globals';

import * as flatsql from '../src';
import path from 'path';
import fs from 'fs';

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

const Token = flatsql.proto.ScannerTokenType;

describe('FlatSQL Scanner', () => {
    it(`Character Sequence`, () => {
        const script = fsql!.createScript();
        let tmp = new flatsql.proto.ScannedScript();

        let size = 0;
        const add = (
            t: string,
            expectedOffsets: number[],
            expectedTypes: flatsql.proto.ScannerTokenType[],
            expectedBreaks: number[],
        ) => {
            script.insertTextAt(size++, t);
            const result = script.scan();
            const scanned = result.read(tmp);

            expect(scanned.tokens()).toBeTruthy();
            let hl = scanned.tokens()!;
            expect(hl.tokenOffsetsArray()).toBeTruthy();
            expect(hl.tokenTypesArray()).toBeTruthy();
            expect(Array.from(hl.tokenOffsetsArray()!)).toEqual(expectedOffsets);
            expect(Array.from(hl.tokenTypesArray()!)).toEqual(expectedTypes);
            expect(Array.from(hl.tokenBreaksArray() ?? new Uint32Array())).toEqual(expectedBreaks);
        };

        add('s', [0, 1], [Token.IDENTIFIER, Token.NONE], []);
        add('e', [0, 2], [Token.IDENTIFIER, Token.NONE], []);
        add('l', [0, 3], [Token.IDENTIFIER, Token.NONE], []);
        add('e', [0, 4], [Token.IDENTIFIER, Token.NONE], []);
        add('c', [0, 5], [Token.IDENTIFIER, Token.NONE], []);
        add('t', [0, 6], [Token.KEYWORD, Token.NONE], []);
        add('\n', [0, 6], [Token.KEYWORD, Token.NONE], [1]);
        add('1', [0, 6, 7, 8], [Token.KEYWORD, Token.NONE, Token.LITERAL_INTEGER, Token.NONE], [1]);

        script.delete();
    });

    describe(`Utils`, () => {
        it(`Should find tokens in range`, () => {
            const test_tokens = (
                text: string,
                expectedOffsets: number[],
                expectedTypes: flatsql.proto.ScannerTokenType[],
                textRange: [number, number],
                expectedFiltered: [number, number],
            ) => {
                const script = fsql!.createScript();
                script.insertTextAt(0, text);
                const scanResult = script.scan();
                const scannedScript = scanResult.read(new flatsql.proto.ScannedScript());
                expect(scannedScript.tokens()).toBeTruthy();

                const hl = scannedScript.tokens();
                expect(hl).toBeTruthy();
                expect(hl!.tokenOffsetsArray()).toBeTruthy();
                expect(hl!.tokenTypesArray()).toBeTruthy();
                expect(Array.from(hl!.tokenOffsetsArray()!)).toEqual(expectedOffsets);
                expect(Array.from(hl!.tokenTypesArray()!)).toEqual(expectedTypes);

                const [textBegin, textEnd] = textRange;
                const [tokenBegin, tokenEnd] = flatsql.findTokensInRange(hl!, textBegin, textEnd);

                expect([tokenBegin, tokenEnd]).toEqual(expectedFiltered);
                script.delete();
            };

            // Full text
            test_tokens(
                'select 1',
                [0, 6, 7, 8],
                [Token.KEYWORD, Token.NONE, Token.LITERAL_INTEGER, Token.NONE],
                [0, 8],
                [0, 3],
            );
            // Expand left
            test_tokens(
                'select 1',
                [0, 6, 7, 8],
                [Token.KEYWORD, Token.NONE, Token.LITERAL_INTEGER, Token.NONE],
                [3, 8],
                [0, 3],
            );
            // Not begin, not end
            test_tokens(
                'select 111111',
                [0, 6, 7, 13],
                [Token.KEYWORD, Token.NONE, Token.LITERAL_INTEGER, Token.NONE],
                [7, 9],
                [2, 3],
            );
            // Begin, expand right
            test_tokens(
                'select 111111',
                [0, 6, 7, 13],
                [Token.KEYWORD, Token.NONE, Token.LITERAL_INTEGER, Token.NONE],
                [0, 9],
                [0, 3],
            );
            // Begin, don't expand right
            test_tokens(
                'select 111111',
                [0, 6, 7, 13],
                [Token.KEYWORD, Token.NONE, Token.LITERAL_INTEGER, Token.NONE],
                [0, 3],
                [0, 1],
            );
        });
    });
});
