import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function printErr(err) {
    if (err) return console.log(err);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, 'dist');

console.log(`[ ESBUILD ] flatsql.module.js`);
esbuild.build({
    entryPoints: [`./index.ts`],
    outfile: `dist/flatsql.module.js`,
    platform: 'neutral',
    format: 'esm',
    target: 'es2020',
    bundle: true,
    minify: false,
    sourcemap: true,
    external: ['flatbuffers'],
});

fs.writeFile(path.join(dist, 'flatsql.module.d.ts'), "export * from './index';", printErr);

const build_dir = path.resolve(__dirname, '..', 'flatsql-parser', 'build', 'wasm', 'Release');
fs.copyFile(path.resolve(build_dir, 'flatsql_parser.wasm'), path.resolve(dist, 'flatsql_parser.wasm'), printErr);

