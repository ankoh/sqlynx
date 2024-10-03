import '@jest/globals';

import * as arrow from 'apache-arrow';
import * as sqlynx_compute from '@ankoh/sqlynx-compute';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { DataFrameIpcStreamIterable } from './sqlynx_compute.js';

const distPath = path.resolve(fileURLToPath(new URL('../../../sqlynx-compute/dist/', import.meta.url)));
const wasmPath = path.resolve(distPath, './sqlynx_compute_bg.wasm');

beforeAll(async () => {
    expect(async () => await fs.promises.access(wasmPath)).resolves;
    const buf = await fs.promises.readFile(wasmPath);
    await sqlynx_compute.default(buf);
    const version = sqlynx_compute.getVersion();
    expect(version.text).toMatch(/^[0-9]+.[0-9]+.[0-9]+(\-dev\.[0-9]+)?$/);
});

describe('SQLynxCompute Arrow IO', () => {
    const testData = new Int32Array([
        1, 2, 3, 4, 5, 6, 7, 8
    ]);
    const inTable0 = arrow.tableFromArrays({
        test: testData,
    });

    it('Ingest', async () => {
        const ingest = new sqlynx_compute.ArrowIngest();
        const tableBuffer = arrow.tableToIPC(inTable0, 'stream');
        ingest.read(tableBuffer);
        const dataFrame = ingest.finish();

        ingest.free();
        dataFrame.free();
    });

    it('Ipc stream', async () => {
        const ingest = new sqlynx_compute.ArrowIngest();
        const tableBuffer = arrow.tableToIPC(inTable0, 'stream');
        ingest.read(tableBuffer);
        const dataFrame = ingest.finish();

        const dataFrameStream = dataFrame.createIpcStream();
        const stream = new DataFrameIpcStreamIterable(dataFrame, dataFrameStream);

        const batchReader = arrow.RecordBatchReader.from<{ 'test': arrow.Int32 }>(stream);
        expect(batchReader.isStream()).toBeTruthy();

        const table = new arrow.Table(batchReader);
        const mapped = table.toArray().map(o => ({ test: o.test }));
        expect(mapped).toEqual([
            { test: 1 },
            { test: 2 },
            { test: 3 },
            { test: 4 },
            { test: 5 },
            { test: 6 },
            { test: 7 },
            { test: 8 },
        ]);
    })
});
