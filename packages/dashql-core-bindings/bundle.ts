import * as esbuild from 'esbuild';
import * as fs from 'fs';

const dist = new URL('dist/', import.meta.url);

const args = process.argv.slice(2);
let mode = 'o3';
if (args.length == 0) {
    console.warn('Usage: node bundle.mjs {o0/o2/o3}');
} else {
    mode = args[0];
}
console.log(`MODE=${mode}`);

console.log(`[ ESBUILD ] dashql.module.js`);
await esbuild.build({
    entryPoints: [`./src/index.ts`],
    outfile: `dist/dashql.module.js`,
    platform: 'neutral',
    format: 'esm',
    target: 'es2020',
    bundle: true,
    minify: false,
    sourcemap: true,
    external: ['flatbuffers'],
});

await fs.promises.writeFile(new URL('dashql.module.d.ts', dist), "export * from './src/index.js';");

let wasmUrl: URL;
switch (mode) {
    case 'o0':
        wasmUrl = new URL('../dashql-core/build/wasm/o0/dashql.wasm', import.meta.url);
        break;
    case 'o2':
        wasmUrl = new URL('../dashql-core/build/wasm/o2/dashql.wasm', import.meta.url);
        break;
    case 'o3':
        wasmUrl = new URL('../dashql-core/build/wasm/o3/dashql.wasm', import.meta.url);
        break;
    default:
        throw new Error(`unsupported mode: ${mode}`);
}
await fs.promises.copyFile(wasmUrl, new URL('dashql.wasm', dist));
