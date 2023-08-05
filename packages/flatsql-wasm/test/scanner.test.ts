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
            expectedLengths: number[],
            expectedTypes: flatsql.proto.ScannerTokenType[],
            expectedBreaks: number[],
        ) => {
            script.insertTextAt(size++, t);
            const result = script.scan();
            const scanned = result.read(tmp);

            expect(scanned.tokens()).toBeTruthy();
            let hl = scanned.tokens()!;
            expect(hl.tokenOffsetsArray()).toBeTruthy();
            expect(hl.tokenLengthsArray()).toBeTruthy();
            expect(hl.tokenTypesArray()).toBeTruthy();
            expect(Array.from(hl.tokenOffsetsArray()!)).toEqual(expectedOffsets);
            expect(Array.from(hl.tokenLengthsArray()!)).toEqual(expectedLengths);
            expect(Array.from(hl.tokenTypesArray()!)).toEqual(expectedTypes);
            expect(Array.from(hl.tokenBreaksArray() ?? new Uint32Array())).toEqual(expectedBreaks);
        };

        add('s', [0], [1], [Token.IDENTIFIER], []);
        add('e', [0], [2], [Token.IDENTIFIER], []);
        add('l', [0], [3], [Token.IDENTIFIER], []);
        add('e', [0], [4], [Token.IDENTIFIER], []);
        add('c', [0], [5], [Token.IDENTIFIER], []);
        add('t', [0], [6], [Token.KEYWORD], []);
        add('\n', [0], [6], [Token.KEYWORD], [1]);
        add('1', [0, 7], [6, 1], [Token.KEYWORD, Token.LITERAL_INTEGER], [1]);

        script.delete();
    });

    describe(`Utils`, () => {
        it(`Should find tokens in range`, () => {
            const test_tokens = (
                text: string,
                expectedOffsets: number[],
                expectedLengths: number[],
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
                expect(hl!.tokenLengthsArray()).toBeTruthy();
                expect(hl!.tokenTypesArray()).toBeTruthy();
                expect(Array.from(hl!.tokenOffsetsArray()!)).toEqual(expectedOffsets);
                expect(Array.from(hl!.tokenLengthsArray()!)).toEqual(expectedLengths);
                expect(Array.from(hl!.tokenTypesArray()!)).toEqual(expectedTypes);

                const [textBegin, textEnd] = textRange;
                const [tokenBegin, tokenEnd] = flatsql.findTokensInRange(hl!, textBegin, textEnd);

                expect([tokenBegin, tokenEnd]).toEqual(expectedFiltered);
                script.delete();
            };

            // Full text
            test_tokens('select 1', [0, 7], [6, 1], [Token.KEYWORD, Token.LITERAL_INTEGER], [0, 8], [0, 2]);
            // Expand left
            test_tokens('select 1', [0, 7], [6, 1], [Token.KEYWORD, Token.LITERAL_INTEGER], [3, 8], [0, 2]);
            // Not begin, not end
            test_tokens('select 111111', [0, 7], [6, 6], [Token.KEYWORD, Token.LITERAL_INTEGER], [7, 9], [1, 2]);
            // Begin, expand right
            test_tokens('select 111111', [0, 7], [6, 6], [Token.KEYWORD, Token.LITERAL_INTEGER], [0, 9], [0, 2]);
            // Begin, don't expand right
            test_tokens('select 111111', [0, 7], [6, 6], [Token.KEYWORD, Token.LITERAL_INTEGER], [0, 3], [0, 1]);
        });
    });
});
