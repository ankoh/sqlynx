import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

function printErr(err: NodeJS.ErrnoException | null) {
    if (err) return console.log(err);
}
const dist = path.resolve(__dirname, 'dist');

console.log(`[ ESBUILD ] hyper-service.module.js`);
esbuild.build({
    entryPoints: [`./index.ts`],
    outfile: `dist/hyper-service.module.js`,
    platform: 'neutral',
    format: 'esm',
    target: 'es2020',
    bundle: true,
    minify: false,
    sourcemap: true,
    external: ['@bufbuild/protobuf', '@connectrpc/connect-web'],
});

fs.writeFile(path.join(dist, 'hyper-service.module.d.ts'), "export * from './index';", printErr);
