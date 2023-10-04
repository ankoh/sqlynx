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
    describe('single script prefix', () => {
        const test = (text: string, cursor_offset: number, expected: string[]) => {
            const script = fsql!.createScript(1);
            script.insertTextAt(0, text);
            script.scan().delete();
            script.parse().delete();
            script.analyze().delete();
            script.reindex();
            script.moveCursor(cursor_offset).delete();

            const completionBuffer = script.completeAtCursor(10);
            const completion = completionBuffer.read(new flatsql.proto.Completion());

            let candidates: string[] = [];
            for (let i = 0; i < completion.candidatesLength(); ++i) {
                const candidate = completion.candidates(i)!;
                candidates.push(candidate.nameText()!);
            }
            expect(candidates).toEqual(expected);
        };

        it('s', () => test('s', 1, ['select', 'set', 'with', 'values', 'table', 'create']));
    });
});
