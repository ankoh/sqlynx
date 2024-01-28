import '@jest/globals';

import * as sqlynx from '../src';
import path from 'path';
import fs from 'fs';

const distPath = path.resolve(__dirname, '../dist');
const wasmPath = path.resolve(distPath, './sqlynx.wasm');

describe('SQLynx setup', () => {
    it('WebAssembly file exists', () => {
        expect(async () => await fs.promises.access(wasmPath)).not.toThrow();
    });
    it('instantiates WebAssembly module', async () => {
        const instance = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
            const buf = await fs.promises.readFile(wasmPath);
            return await WebAssembly.instantiate(buf, imports);
        });
        expect(instance).not.toBeNull();
        expect(instance).not.toBeUndefined();
        const version = instance.getVersionText();
        expect(version).not.toBeFalsy();
        expect(version).not.toEqual('');
        console.log(version);
    });
});
