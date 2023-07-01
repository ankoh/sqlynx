import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

function printErr(err: NodeJS.ErrnoException | null) {
    if (err) return console.log(err);
}
const dist = new URL('dist/', import.meta.url);

let isDebug = false;
let args = process.argv.slice(2);
if (args.length == 0) {
    console.warn('Usage: node bundle.mjs {debug/release}');
} else {
    if (args[0] == 'debug') isDebug = true;
}
console.log(`DEBUG=${isDebug}`);

console.log(`[ ESBUILD ] flatsql.module.js`);
await esbuild.build({
    entryPoints: [`./src/index.ts`],
    outfile: `dist/flatsql.module.js`,
    platform: 'neutral',
    format: 'esm',
    target: 'es2020',
    bundle: true,
    minify: false,
    sourcemap: true,
    external: ['flatbuffers'],
});

await fs.promises.writeFile(new URL('flatsql.module.d.ts', dist), "export * from './src';");

const wasmUrl = new URL('../flatsql/build/wasm/Release/flatsql.wasm', import.meta.url);
await fs.promises.copyFile(wasmUrl, new URL('flatsql.wasm', dist));
