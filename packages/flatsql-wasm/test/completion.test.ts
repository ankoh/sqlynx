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

describe('FlatSQL Completion', () => {
    it('manually', () => {
        const script = fsql!.createScript(1);
        script.insertTextAt(0, 'selec');
        script.scan().delete();
        script.parse().delete();
        script.analyze().delete();
        script.reindex();

        const cursorBuffer = script.moveCursor(5);
        const cursor = cursorBuffer.read(new flatsql.proto.ScriptCursorInfo());
        expect(cursor.scannerSymbolId()).toEqual(0);
        expect(cursor.scannerRelativePosition()).toEqual(flatsql.proto.RelativeSymbolPosition.END_OF_SYMBOL);

        const completionBuffer = script.completeAtCursor(10);
        const completion = completionBuffer.read(new flatsql.proto.Completion());
        expect(completion.scannerTokenId()).toEqual(0);
        expect(completion.textOffset()).toEqual(5);

        let candidates: string[] = [];
        let scores: number[] = [];
        for (let i = 0; i < completion.candidatesLength(); ++i) {
            const candidate = completion.candidates(i)!;
            candidates.push(candidate.nameText()!);
            scores.push(candidate.score());
        }
        expect(candidates).toEqual(['select', 'set', 'with', 'table', 'create', 'values']);
        expect(scores).toEqual([50, 0, 0, 0, 0, 0]);

        script.delete();
    });
});
