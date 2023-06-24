import '@jest/globals';

import * as flatsql from '../src';
import path from 'path';
import fs from 'fs';

const distPath = path.resolve(__dirname, '../dist');
const wasmPath = path.resolve(distPath, './flatsql.wasm');

describe('FlatSQL.create', () => {
    it('instantiate WebAssembly module', () => {
        flatsql.FlatSQL.create(async (imports: WebAssembly.Imports) => {
            const buf = fs.readFileSync(wasmPath);
            return await WebAssembly.instantiate(buf, imports);
        });
    });
});
