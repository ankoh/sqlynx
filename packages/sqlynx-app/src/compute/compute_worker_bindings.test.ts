import '@jest/globals';

import * as compute from '@ankoh/sqlynx-compute';
import * as path from 'path';
import * as fs from 'fs';

import { fileURLToPath } from 'node:url';

const distPath = path.resolve(fileURLToPath(new URL('../../../sqlynx-compute/dist/', import.meta.url)));
const wasmPath = path.resolve(distPath, './sqlynx_compute_bg.wasm');

beforeAll(async () => {
    expect(async () => await fs.promises.access(wasmPath)).resolves;
    const buf = await fs.promises.readFile(wasmPath);
    await compute.default({
        module_or_path: buf
    });
    const version = compute.getVersion();
    expect(version.text).toMatch(/^[0-9]+.[0-9]+.[0-9]+(\-dev\.[0-9]+)?$/);
});

describe('SQLynxCompute Worker', () => {
    it('Dummy', async () => { });
});
