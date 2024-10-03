import '@jest/globals';

import * as SQLynxCompute from '@ankoh/sqlynx-compute';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';

const distPath = path.resolve(fileURLToPath(new URL('../../sqlynx-compute/dist/', import.meta.url)));
const wasmPath = path.resolve(distPath, './sqlynx_compute_bg.wasm');

describe('SQLynxCompute setup', () => {
    it('WebAssembly file exists', () => {
        expect(async () => await fs.promises.access(wasmPath)).resolves;
    });
    it('instantiates WebAssembly module', async () => {
        const buf = await fs.promises.readFile(wasmPath);
        await SQLynxCompute.default(buf);
        const version = SQLynxCompute.getVersion();
        expect(version).not.toEqual("");
    });
});
