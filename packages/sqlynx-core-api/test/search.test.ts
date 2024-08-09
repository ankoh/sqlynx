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

describe('Search', () => {
    describe('table refs', () => {
        it('empty', async () => {
            const script = packScript([], [])
            const tmp = new sqlynx.proto.IndexedTableReference();
            const iter = sqlynx.lowerBoundTableRefs(script, tmp, 0, 0, 0, 0, 0n);
            expect(iter).toEqual(0);
        });

        it('hit 1', async () => {
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
        })
    });
});
