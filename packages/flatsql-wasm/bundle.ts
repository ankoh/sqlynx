import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

function printErr(err: NodeJS.ErrnoException | null) {
    if (err) return console.log(err);
}
const dist = path.resolve(__dirname, 'dist');

let isDebug = false;
let args = process.argv.slice(2);
if (args.length == 0) {
    console.warn('Usage: node bundle.mjs {debug/release}');
} else {
    if (args[0] == 'debug') isDebug = true;
}
console.log(`DEBUG=${isDebug}`);

(async () => {
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

    fs.writeFile(path.join(dist, 'flatsql.module.d.ts'), "export * from './src';", printErr);

    const build_dir = path.resolve(__dirname, '..', 'flatsql', 'build', 'wasm', 'Release');
    fs.copyFile(path.resolve(build_dir, 'flatsql.wasm'), path.resolve(dist, 'flatsql.wasm'), printErr);
})();
