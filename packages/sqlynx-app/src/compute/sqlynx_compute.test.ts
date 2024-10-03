import '@jest/globals';

import * as arrow from 'apache-arrow';
import * as sqlynx_compute from '@ankoh/sqlynx-compute';
import * as pb from '@ankoh/sqlynx-protobuf';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { DataFrameIpcStreamIterable, dataFrameFromTable as createDataFrameFromTable, readDataFrame } from './sqlynx_compute.js';

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
        const dataFrame = createDataFrameFromTable(inTable0);
        dataFrame.free();
    });

    it('IPC stream', async () => {
        const dataFrame = createDataFrameFromTable(inTable0);

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

        dataFrameStream.free();
        dataFrame.free();
    })
});

const testOrderByColumn = async (inTable: arrow.Table, columnName: string, asc: boolean, nullsFirst: boolean, mapper: (o: any) => any, expected: any[]) => {
    const dataFrame = createDataFrameFromTable(inTable);
    const orderByConfig = new pb.sqlynx_compute.pb.OrderByConfig({
        fieldName: columnName,
        ascending: asc,
        nullsFirst
    });
    const orderByConfigBytes = orderByConfig.toBinary();
    const orderedFrame = await dataFrame.orderBy(orderByConfigBytes);
    dataFrame.free();

    const table = readDataFrame(orderedFrame);
    orderedFrame.free();

    const mapped = table.toArray().map(mapper);
    expect(mapped).toEqual(expected);
};

describe('SQLynxCompute OrderBy', () => {
    it('Float64', async () => {
        const t = arrow.tableFromArrays({
            id: new Int32Array([1, 2, 3, 4]),
            score: new Float64Array([42.0, 10.2, 10.1, 30.005])
        });
        testOrderByColumn(t, "score", true, false, o => ({ id: o.id, score: o.score }), [
            { id: 3, score: 10.1 },
            { id: 2, score: 10.2 },
            { id: 4, score: 30.005 },
            { id: 1, score: 42.0 },
        ]);
    });
});
