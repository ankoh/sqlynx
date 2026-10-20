import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../npm_package/dist/index.js';
import * as glue from '../npm_package/dist/wasm/dashql_core.js';

assert.equal('createBatchWorker' in core, false);
assert.equal('DashQLBatchWorker' in core, false);
const binary = new Uint8Array(await readFile(new URL('../npm_package/dist/wasm/dashql_core.wasm', import.meta.url)));
const first = await core.DashQL.create();
await glue.default({ module_or_path: binary });
const second = new core.DashQL({ ...glue });
assert.notEqual(first, second);
for (const instance of [first, second]) {
    const catalog = instance.createCatalog();
    const script = instance.createScript(catalog);
    script.insertTextAt(0, 'select 1');
    script.analyze();
    assert.equal(script.toString(), 'select 1');
    const result = instance.processBatch({ scripts: [{ id: 'query', text: 'select 1', outputs: ['analyzed'] }] });
    assert.equal(result.scripts.length, 1);
    assert.ok(result.scripts[0].analyzed.byteLength > 0);
    instance.resetUnsafe();
}
const worker = await import('../npm_package/dist/browser_worker.js');
assert.equal(typeof worker.createBatchWorker, 'function');
console.log('DashQL npm package Node smoke test passed');
