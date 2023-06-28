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

const Token = flatsql.proto.HighlightingTokenType;

describe('FlatSQL Highlighting', () => {
    it(`Character Sequence`, () => {
        const script = fsql!.createScript();
        let tmp = new flatsql.proto.ScannedScript();

        let size = 0;
        const add = (
            t: string,
            expectedOffsets: number[],
            expectedTypes: flatsql.proto.HighlightingTokenType[],
            expectedBreaks: number[],
        ) => {
            script.insertTextAt(size++, t);
            const result = script.scan();
            const scanned = result.read(tmp);

            expect(scanned.highlighting()).toBeTruthy();
            let hl = scanned.highlighting()!;

            expect(hl.tokenOffsetsArray()).toBeTruthy();
            expect(hl.tokenTypesArray()).toBeTruthy();
            let tokenOffsets = hl.tokenOffsetsArray()!;
            let tokenTypes = hl.tokenTypesArray()!;
            let tokenBreaks = hl.tokenBreaksArray() ?? new Uint32Array();

            let offsets: number[] = [];
            let types: flatsql.proto.HighlightingTokenType[] = [];
            let breaks: number[] = [];
            for (let i = 0; i < tokenOffsets.length; ++i) {
                offsets.push(tokenOffsets[i]);
            }
            for (let i = 0; i < tokenTypes.length; ++i) {
                types.push(tokenTypes[i]);
            }
            for (let i = 0; i < tokenBreaks.length; ++i) {
                breaks.push(tokenBreaks[i]);
            }
            expect(offsets).toEqual(expectedOffsets);
            expect(types).toEqual(expectedTypes);
            expect(breaks).toEqual(expectedBreaks);
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
});
