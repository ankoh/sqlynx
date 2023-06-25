import '@jest/globals';

import * as flatsql from '../src';
import path from 'path';
import fs from 'fs';

const distPath = path.resolve(__dirname, '../dist');
const wasmPath = path.resolve(distPath, './flatsql.wasm');

describe('FlatSQL setup', () => {
    it('instantiates WebAssembly module', () => {
        const instance = flatsql.FlatSQL.create(async (imports: WebAssembly.Imports) => {
            const buf = await fs.promises.readFile(wasmPath);
            return await WebAssembly.instantiate(buf, imports);
        });
        expect(instance).not.toBeNull();
    });
});
