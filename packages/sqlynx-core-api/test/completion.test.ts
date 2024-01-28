import '@jest/globals';

import * as sqlynx from '../src';
import path from 'path';
import fs from 'fs';

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

describe('SQLynx Completion', () => {
    describe('single script prefix', () => {
        const test = (text: string, cursor_offset: number, expected: string[]) => {
            const script = lnx!.createScript(null, 1);
            script.insertTextAt(0, text);
            script.scan().delete();
            script.parse().delete();
            script.analyze().delete();
            script.moveCursor(cursor_offset).delete();

            const completionBuffer = script.completeAtCursor(10);
            const completion = completionBuffer.read(new sqlynx.proto.Completion());

            let candidates: string[] = [];
            for (let i = 0; i < completion.candidatesLength(); ++i) {
                const candidate = completion.candidates(i)!;
                candidates.push(candidate.completionText()!);
            }
            expect(candidates).toEqual(expected);
        };

        it('s', () => test('s', 1, ['select', 'set', 'values', 'with', 'create', 'table']));
    });
});
