import '@jest/globals';

import * as sqlynx from '../src/index.js';
import * as flatbuffers from 'flatbuffers';

function tableRef(db: number, schema: number, table: bigint, refId: number) {
    return new sqlynx.proto.IndexedTableReferenceT(db, schema, table, refId);
}
function packScript(tableRefs: sqlynx.proto.IndexedTableReferenceT[], columnRefs: sqlynx.proto.IndexedColumnReferenceT[]) {
    const script = new sqlynx.proto.AnalyzedScriptT(0, [], [], [], [], [], tableRefs, columnRefs);
    const builder = new flatbuffers.Builder();
    const ofs = script.pack(builder);
    builder.finish(ofs);
    const buffer = builder.dataBuffer();
    return sqlynx.proto.AnalyzedScript.getRootAsAnalyzedScript(buffer);
}

describe('Lookup', () => {
    describe('table refs', () => {
        it('empty', async () => {
            const script = packScript([], [])
            const tmp = new sqlynx.proto.IndexedTableReference();
            const iter = sqlynx.lowerBoundTableRefs(script, tmp, 0, 0, 0, 0, 0n);
            expect(iter).toEqual(0);
        });

        it('single hit', async () => {
            const script = packScript([
                tableRef(1, 2, sqlynx.ExternalObjectID.create(42, 3), 0)
            ], [])
            const tmp = new sqlynx.proto.IndexedTableReference();
            const iter = sqlynx.lowerBoundTableRefs(script, tmp, 0, 1, 1, 2, 0n);
            expect(iter).toEqual(0);
        });

        it('skip 1', async () => {
            const script = packScript([
                tableRef(1, 1, sqlynx.ExternalObjectID.create(42, 2), 0),
                tableRef(1, 2, sqlynx.ExternalObjectID.create(42, 3), 0)
            ], [])
            const tmp = new sqlynx.proto.IndexedTableReference();
            const iter = sqlynx.lowerBoundTableRefs(script, tmp, 0, 2, 1, 2, 0n);
            expect(iter).toEqual(1);
        });

        it('100 last', async () => {
            const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
            for (let i = 0; i < 100; ++i) {
                tableRefs.push(tableRef(1, 2, sqlynx.ExternalObjectID.create(42, i), 0));
            }
            tableRefs.push(tableRef(1, 2, sqlynx.ExternalObjectID.create(43, 1), 0))
            const script = packScript(tableRefs, []);
            const tmp = new sqlynx.proto.IndexedTableReference();
            const iter = sqlynx.lowerBoundTableRefs(script, tmp, 0, tableRefs.length, 1, 2, sqlynx.ExternalObjectID.create(43, 0));
            expect(iter).toEqual(100);
        });

        it('100 first', async () => {
            const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
            tableRefs.push(tableRef(1, 2, sqlynx.ExternalObjectID.create(41, 1), 0))
            for (let i = 0; i < 100; ++i) {
                tableRefs.push(tableRef(1, 2, sqlynx.ExternalObjectID.create(42, i), 0));
            }
            const script = packScript(tableRefs, []);
            const tmp = new sqlynx.proto.IndexedTableReference();
            const iter = sqlynx.lowerBoundTableRefs(script, tmp, 0, tableRefs.length, 1, 2, sqlynx.ExternalObjectID.create(41, 0));
            expect(iter).toEqual(0);
        });

        it('100 mid', async () => {
            const tableRefs: sqlynx.proto.IndexedTableReferenceT[] = [];
            for (let i = 0; i < 50; ++i) {
                tableRefs.push(tableRef(1, 2, sqlynx.ExternalObjectID.create(42, i), 0));
            }
            tableRefs.push(tableRef(1, 2, sqlynx.ExternalObjectID.create(43, 1), 0))
            for (let i = 0; i < 50; ++i) {
                tableRefs.push(tableRef(1, 2, sqlynx.ExternalObjectID.create(44, i), 0));
            }
            const script = packScript(tableRefs, []);
            const tmp = new sqlynx.proto.IndexedTableReference();
            const iter = sqlynx.lowerBoundTableRefs(script, tmp, 0, tableRefs.length, 1, 2, sqlynx.ExternalObjectID.create(43, 0));
            expect(iter).toEqual(50);
        });
    });
});
