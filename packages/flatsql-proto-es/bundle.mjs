import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function printErr(err) {
    if (err) return console.log(err);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, 'dist');

console.log(`[ ESBUILD ] flatsql-proto.esm.js`);
esbuild.build({
    entryPoints: [`./index.ts`],
    outfile: `dist/flatsql-proto.esm.js`,
    platform: 'neutral',
    format: 'esm',
    target: 'es2020',
    bundle: true,
    minify: false,
    sourcemap: true,
    external: ['flatbuffers'],
});

fs.writeFile(path.join(dist, 'flatsql-proto.esm.d.ts'), "export * from './index';", printErr);
