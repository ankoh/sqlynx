import esbuild from 'esbuild';

console.log(`[ ESBUILD ] action.js`);
esbuild.build({
    entryPoints: [`./action.ts`],
    outfile: `dist/action.js`,
    platform: 'node',
    format: 'esm',
    target: 'es2020',
    bundle: true,
    minify: false,
    sourcemap: false,
    external: [],
});
