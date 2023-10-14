import '@jest/globals';

import * as sqlynx from '../src';
import path from 'path';
import fs from 'fs';

const distPath = path.resolve(__dirname, '../dist');
const wasmPath = path.resolve(distPath, './sqlynx.wasm');

let fsql: sqlynx.SQLynx | null = null;

beforeAll(async () => {
    fsql = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(fsql).not.toBeNull();
});

describe('SQLynx SchemaGraph', () => {
    it('dummy', () => {
        expect(3).toEqual(3);
    });
});
