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

const Token = dashql.buffers.parser.ScannerTokenType;

describe('DashQL Scanner', () => {
    it(`Character Sequence`, () => {
        const catalog = dql!.createCatalog();
        const script = dql!.createScript(catalog);

        const tmpParsed = new dashql.buffers.parser.ParsedScript();
        let size = 0;
        const add = (
            t: string,
            expectedOffsets: number[],
            expectedLengths: number[],
            expectedTypes: dashql.buffers.parser.ScannerTokenType[],
            expectedBreaks: number[],
        ) => {
            script.insertTextAt(size++, t);
            script.analyze();
            const result = script.getParsed();
            const parsed = result.read(tmpParsed);

            expect(parsed.tokens()).toBeTruthy();
            const hl = parsed.tokens()!;
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
    });

    describe(`Utils`, () => {
        it(`Should resolve symbol spans independently of comments`, () => {
            const catalog = dql!.createCatalog();
            const script = dql!.createScript(catalog);
            const text = '-- leading comment\nselect /* middle comment */ 1';
            script.insertTextAt(0, text);
            script.analyze();

            const parsed = script.getParsed().read();
            const tokens = parsed.tokens()!;
            const tokenOffsets = Array.from(tokens.tokenOffsetsArray()!);
            expect(tokenOffsets).toEqual([text.indexOf('select'), text.lastIndexOf('1')]);
            expect(parsed.commentsLength()).toBe(2);
            const comment = new dashql.buffers.parser.TextSpan();
            expect(parsed.comments(0, comment)?.offset()).toBe(0);
            expect(parsed.comments(1, comment)?.offset()).toBe(text.indexOf('/*'));
            const span = (offset: number, length: number) => ({
                offset: () => offset,
                length: () => length,
            }) as dashql.buffers.parser.SymbolSpan;

            expect(dashql.resolveSymbolSpan(tokens, span(0, 1)))
                .toEqual({ offset: text.indexOf('select'), length: 'select'.length });
            expect(dashql.resolveSymbolSpan(tokens, span(1, 1)))
                .toEqual({ offset: text.lastIndexOf('1'), length: 1 });
        });

        it(`Should find tokens in range`, () => {
            const test_tokens = (
                text: string,
                expectedOffsets: number[],
                expectedLengths: number[],
                expectedTypes: dashql.buffers.parser.ScannerTokenType[],
                textRange: [number, number],
                expectedFiltered: [number, number],
            ) => {
                const catalog = dql!.createCatalog();
                const script = dql!.createScript(catalog);
                script.insertTextAt(0, text);
                script.analyze();
                const parseResult = script.getParsed();
                const parsedScript = parseResult.read();
                expect(parsedScript.tokens()).toBeTruthy();

                const hl = parsedScript.tokens();
                expect(hl).toBeTruthy();
                expect(hl!.tokenOffsetsArray()).toBeTruthy();
                expect(hl!.tokenLengthsArray()).toBeTruthy();
                expect(hl!.tokenTypesArray()).toBeTruthy();
                expect(Array.from(hl!.tokenOffsetsArray()!)).toEqual(expectedOffsets);
                expect(Array.from(hl!.tokenLengthsArray()!)).toEqual(expectedLengths);
                expect(Array.from(hl!.tokenTypesArray()!)).toEqual(expectedTypes);

                const [textBegin, textEnd] = textRange;
                const [tokenBegin, tokenEnd] = dashql.findTokensInRange(hl!, textBegin, textEnd);

                expect([tokenBegin, tokenEnd]).toEqual(expectedFiltered);
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
