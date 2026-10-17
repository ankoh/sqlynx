import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export interface SqlFile {
    /// Stable id of the script: the path relative to the input directory
    id: string;
    path: string;
    text: string;
    hash: string;
}

export function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

/// Resolve a user-provided path. Under `bazel run` the process runs in the runfiles tree,
/// relative paths are meant to be relative to the invoking shell directory.
export function resolveUserPath(path: string): string {
    if (isAbsolute(path)) return path;
    return resolve(process.env.BUILD_WORKING_DIRECTORY ?? process.cwd(), path);
}

async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        // Follow symlinks, SQL libraries are often linked into place
        const info = entry.isSymbolicLink() ? await stat(path).catch(() => null) : entry;
        if (!info) continue;
        if (info.isDirectory()) {
            if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) out.push(...(await walk(path)));
        } else if (info.isFile() && entry.name.toLowerCase().endsWith('.sql')) {
            out.push(path);
        }
    }
    return out;
}

/// Collect SQL scripts from directories (recursively) and explicit file paths
export async function collectSqlFiles(inputs: string[]): Promise<SqlFile[]> {
    const files = new Map<string, SqlFile>();
    for (const input of inputs) {
        const root = resolveUserPath(input);
        const info = await stat(root);
        const paths = info.isDirectory() ? await walk(root) : [root];
        for (const path of paths) {
            const id = info.isDirectory() ? relative(root, path) : basename(path);
            const uniqueId = files.has(id) ? relative(resolveUserPath('.'), path) : id;
            const text = await readFile(path, 'utf8');
            files.set(uniqueId, { id: uniqueId, path, text, hash: sha256(text) });
        }
    }
    return [...files.values()];
}
