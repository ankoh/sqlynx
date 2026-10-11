import * as dashql from './index.js';

import { loadCoreWasm } from './test_fixture.js';

let dql: dashql.DashQL | null = null;
beforeAll(async () => {
    const wasmBinary = await loadCoreWasm();
    dql = await dashql.DashQL.create({ wasmBinary });
    expect(dql).not.toBeNull();
});
afterEach(async () => {
    dql!.resetUnsafe();
});

type OpSummary = {
    code: dashql.buffers.diff.ScriptDiffOpCode;
    source: number | null;
    target: number | null;
    targetChanges: string[];
};

/// Compute the diff from `source` to `target` and summarize the ops.
function diffOps(source: string, target: string): OpSummary[] {
    const catalog = dql!.createCatalog();
    const sourceScript = dql!.createScript(catalog);
    const targetScript = dql!.createScript(catalog);
    try {
        sourceScript.insertTextAt(0, source);
        sourceScript.parse();
        targetScript.insertTextAt(0, target);
        targetScript.parse();

        const diffPtr = sourceScript.computeDiff(targetScript);
        const diff = diffPtr.read();
        const NONE = 0xffffffff;

        const ops: OpSummary[] = [];
        for (let i = 0; i < diff.opsLength(); ++i) {
            const op = diff.ops(i)!;
            const changes: string[] = [];
            for (let j = 0; j < op.targetChangesLength(); ++j) {
                const span = op.targetChanges(j)!;
                changes.push(target.substring(span.offset(), span.offset() + span.length()));
            }
            ops.push({
                code: op.code(),
                source: op.sourceStatement() === NONE ? null : op.sourceStatement(),
                target: op.targetStatement() === NONE ? null : op.targetStatement(),
                targetChanges: changes,
            });
        }
        return ops;
    } finally {
        sourceScript.destroy();
        targetScript.destroy();
        catalog.destroy();
    }
}

describe('DashQL script diff', () => {
    const OpCode = dashql.buffers.diff.ScriptDiffOpCode;

    it('reports KEEP for identical scripts', () => {
        const ops = diffOps('select a from t;\nselect b from u;', 'select a from t;\nselect b from u;');
        expect(ops.map(o => o.code)).toEqual([OpCode.KEEP, OpCode.KEEP]);
    });

    it('reports INSERT for an appended statement', () => {
        const ops = diffOps('select a from t;', 'select a from t;\nselect b from u;');
        expect(ops.map(o => o.code)).toEqual([OpCode.KEEP, OpCode.INSERT]);
        const insert = ops.find(o => o.code === OpCode.INSERT)!;
        expect(insert.source).toBeNull();
        expect(insert.target).toEqual(1);
    });

    it('reports DELETE for a removed statement', () => {
        const ops = diffOps('select a from t;\nselect b from u;', 'select a from t;');
        expect(ops.map(o => o.code)).toEqual([OpCode.KEEP, OpCode.DELETE]);
        const del = ops.find(o => o.code === OpCode.DELETE)!;
        expect(del.source).toEqual(1);
        expect(del.target).toBeNull();
    });

    it('reports MOVE for reordered statements', () => {
        const ops = diffOps('select a from t;\nselect b from u;', 'select b from u;\nselect a from t;');
        expect(ops.some(o => o.code === OpCode.MOVE)).toBeTruthy();
    });

    it('reports UPDATE with target changes for an edited statement', () => {
        const ops = diffOps('select a from t where x = 1;', 'select a from t where x = 2;');
        expect(ops.length).toEqual(1);
        const update = ops[0];
        expect(update.code).toEqual(OpCode.UPDATE);
        expect(update.source).toEqual(0);
        expect(update.target).toEqual(0);
        expect(update.targetChanges).toEqual(['2']);
    });
});
