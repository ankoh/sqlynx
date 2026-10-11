import { defineConfig } from 'vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const root = process.cwd();
const packaged = path.resolve(root, 'packaged');
const metadata = JSON.parse(readFileSync(path.join(packaged, 'package.json'), 'utf8'));
// Exact aliases expose only the published entry points, never private package files.
const packageAliases = Object.entries(metadata.exports).map(([entry, target]) => ({
    find: new RegExp(`^${metadata.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${entry === '.' ? '' : entry.slice(1)}(\\?.*)?$`),
    replacement: path.resolve(packaged, typeof target === 'string' ? target : target.import) + '$1',
}));
export default defineConfig({
    root,
    publicDir: false,
    plugins: [{
        name: 'bazel-preserve-html-entry-symlinks',
        enforce: 'pre',
        resolveId(id) {
            if (id.endsWith('.html') && path.isAbsolute(id)) return id;
        },
    }],
    resolve: {
        alias: [
            { find: /^vitest$/, replacement: path.resolve(root, 'vitest_compat.ts') },
            ...packageAliases,
        ],
    },
    build: {
        target: 'es2020',
        rolldownOptions: {
            input: path.resolve(root, 'tests.html'),
            external: id => id.startsWith('node:'),
        },
    },
    worker: { format: 'es' },
});
