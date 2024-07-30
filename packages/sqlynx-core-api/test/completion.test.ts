import '@jest/globals';

import * as sqlynx from '../src/index.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';

const distPath = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
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
            const catalog = lnx!.createCatalog();
            const script = lnx!.createScript(catalog, 1);
            script.insertTextAt(0, text);
            script.scan().delete();
            script.parse().delete();
            script.analyze().delete();
            script.moveCursor(cursor_offset).delete();

            const completionBuffer = script.completeAtCursor(10);
            const completion = completionBuffer.read(new sqlynx.proto.Completion());

            const candidates: string[] = [];
            for (let i = 0; i < completion.candidatesLength(); ++i) {
                const candidate = completion.candidates(i)!;
                candidates.push(candidate.completionText()!);
            }
            expect(candidates).toEqual(expected);

            script.delete();
            catalog.delete();
        };

        it('s', () => test('s', 1, ['select', 'set', 'values', 'with', 'create', 'table']));
    });
});
