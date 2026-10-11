import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const tests = dirname(fileURLToPath(import.meta.url));
const consumer = await mkdtemp(join(process.env.TEST_TMPDIR ?? tmpdir(), 'dashql-consumer-'));
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };

try {
    const packageDir = join(consumer, 'node_modules/@ankoh/dashql-core');
    const tarball = await readFile(join(tests, '../dashql-core.tgz'));
    assert.deepEqual(tarball, await readFile(join(tests, '../dashql-core-rebuilt.tgz')), 'archive actions must be byte-reproducible');
    const archive = gunzipSync(tarball);
    const paths = new Set();
    // npm_tarball emits regular files/directories in ustar format, with no links.
    // Reading the actual archive here avoids a host tar executable in the test.
    for (let offset = 0; offset < archive.length && archive[offset] !== 0;) {
        const header = archive.subarray(offset, offset + 512);
        const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
        const prefix = field(345, 155);
        const path = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`.replace(/\/$/, '');
        assert.ok(path === 'package' || path.startsWith('package/'), `unexpected tar path: ${path}`);
        assert.ok(!path.split('/').some(part => part === '..' || part === '.'), `unsafe tar path: ${path}`);
        assert.ok(!paths.has(path), `duplicate tar path: ${path}`);
        paths.add(path);
        const size = Number.parseInt(field(124, 12).trim(), 8) || 0;
        assert.equal(Number.parseInt(field(108, 8).trim(), 8), 0, `non-normalized uid: ${path}`);
        assert.equal(Number.parseInt(field(116, 8).trim(), 8), 0, `non-normalized gid: ${path}`);
        const destination = join(packageDir, path.slice('package'.length));
        const type = field(156, 1);
        if (type === '5') {
            await mkdir(destination, { recursive: true });
        } else {
            assert.ok(type === '0' || type === '', `unsupported tar entry ${type}: ${path}`);
            assert.ok(offset + 512 + size <= archive.length, `truncated tar entry: ${path}`);
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, archive.subarray(offset + 512, offset + 512 + size));
        }
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    assert.deepEqual((await readdir(packageDir)).sort(), ['LICENSE', 'NOTICE', 'README.md', 'dist', 'package.json']);
    assert.ok([...paths].every(path => !/\.test\.|test_fixture|\/node_modules\//.test(path)));
    const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    assert.deepEqual(metadata, JSON.parse(await readFile(join(tests, '../package.json'), 'utf8')));
    assert.equal(metadata.license, 'MPL-2.0');
    assert.equal(metadata.publishConfig.access, 'public');
    for (const file of ['LICENSE', 'NOTICE']) {
        assert.deepEqual(await readFile(join(packageDir, file)), await readFile(join(tests, '..', file)));
    }
    assert.deepEqual(Object.keys(metadata.dependencies), ['flatbuffers']);
    const flatbuffers = dirname(require.resolve('flatbuffers/package.json'));
    assert.equal(JSON.parse(await readFile(join(flatbuffers, 'package.json'), 'utf8')).version, metadata.dependencies.flatbuffers);
    // Copy rather than symlink: dependency resolution cannot escape into runfiles.
    await cp(flatbuffers, join(consumer, 'node_modules/flatbuffers'), { recursive: true, dereference: true });
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    for (const file of ['consumer.mjs', 'consumer.mts']) {
        await cp(join(tests, file), join(consumer, file));
    }
    assert.deepEqual((await readdir(join(consumer, 'node_modules'))).sort(), ['@ankoh', 'flatbuffers']);
    const runtime = spawnSync(process.execPath, [join(consumer, 'consumer.mjs')], { cwd: consumer, env, encoding: 'utf8' });
    assert.equal(runtime.status, 0, runtime.error?.message ?? `${runtime.stdout}\n${runtime.stderr}`);
    console.log(runtime.stdout.trim());
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
            lib: ['ES2022', 'WebWorker'], types: [], strict: true, skipLibCheck: false, noEmit: true,
        },
        files: ['consumer.mts'],
    }));
    const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
    const declarations = spawnSync(process.execPath, [tsc, '--project', join(consumer, 'tsconfig.json')], {
        cwd: consumer, env, encoding: 'utf8',
    });
    assert.equal(declarations.status, 0, declarations.error?.message ?? `${declarations.stdout}\n${declarations.stderr}`);
    console.log('External NodeNext declarations passed with explicit WebWorker typings and no DOM library');
    console.log('Archive reproducibility, metadata, license/notice, and dependency isolation passed');
} finally {
    await rm(consumer, { recursive: true, force: true });
}
