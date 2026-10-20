import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '@ankoh/dashql-core';
import * as buffers from '@ankoh/dashql-core/buffers';
import * as glue from '@ankoh/dashql-core/wasm/glue';

assert.equal(globalThis.Worker, undefined);
assert.equal(globalThis.window, undefined);
assert.equal('createBatchWorker' in core, false);
assert.equal('DashQLBatchWorker' in core, false);
assert.equal(core.buffers.parser.ParsedScript, buffers.parser.ParsedScript);
const worker = await import('@ankoh/dashql-core/browser-worker');
assert.equal(typeof worker.createBatchWorker, 'function');
assert.equal(typeof worker.DashQLBatchWorker, 'function');
const binary = new Uint8Array(await readFile(new URL(import.meta.resolve('@ankoh/dashql-core/wasm'))));
assert.equal(WebAssembly.validate(binary), true);
const instances = [
    await core.DashQL.create(),
    await core.DashQL.create({ wasmBinary: binary }),
    await glue.default({ module_or_path: binary }).then(() => new core.DashQL({ ...glue })),
];
for (const instance of instances) {
    try {
        const script = instance.createScript(instance.createCatalog());
        script.insertTextAt(0, 'select 1');
        script.analyze();
        assert.equal(script.toString(), 'select 1');
        const result = instance.processBatch({ scripts: [{ id: 'query', text: 'select 1', outputs: ['analyzed'] }] });
        assert.equal(result.scripts.length, 1);
        assert.ok(result.scripts[0].analyzed.byteLength > 0);
    } finally {
        instance.resetUnsafe();
    }
}
await assert.rejects(import('@ankoh/dashql-core/dist/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
console.log('Tarball package-name exports, browser-safe imports, and Wasm passed');
