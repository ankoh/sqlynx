import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/// A script and where it was read from
export interface SqlFile {
    /// The path relative to the invoking directory, absolute for files outside of it, `<stdin>` for stdin
    id: string;
    text: string;
    /// The file the script was read from, null for stdin
    path: string | null;
}

/// The id of a script read from stdin
export const STDIN = '-';

/// The directory the user invoked the CLI from. Under `bazel run` the process runs in the runfiles tree.
function workingDirectory(): string {
    return process.env.BUILD_WORKING_DIRECTORY ?? process.cwd();
}

/// Resolve a user-provided path against the invoking shell directory
export function resolveUserPath(path: string): string {
    if (isAbsolute(path)) return path;
    return resolve(workingDirectory(), path);
}

/// Catalog dumps that notebooks keep next to their scripts, they describe the connection and are not meant to run
const GENERATED_FILES = new Set(['dashql-functions.sql', 'dashql-relations.sql']);

/// Paths relative to the invoking directory, absolute ones for files outside of it
function displayPath(path: string): string {
    const rel = relative(workingDirectory(), path);
    return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? path : rel;
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
        } else if (info.isFile() && entry.name.toLowerCase().endsWith('.sql') && !GENERATED_FILES.has(entry.name)) {
            out.push(path);
        }
    }
    return out;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

/// Read SQL scripts from files, directories (recursively, *.sql only, without generated catalog files) and stdin (`-`).
/// Scripts are identified by their path relative to the invoking directory.
export async function readInputs(paths: string[]): Promise<SqlFile[]> {
    const inputs = new Map<string, SqlFile>();
    for (const path of paths) {
        if (path === STDIN) {
            inputs.set('<stdin>', { id: '<stdin>', text: await readStdin(), path: null });
            continue;
        }
        const root = resolveUserPath(path);
        const files = (await stat(root)).isDirectory() ? await walk(root) : [root];
        for (const file of files) {
            const id = displayPath(file);
            if (!inputs.has(id)) inputs.set(id, { id, text: await readFile(file, 'utf8'), path: file });
        }
    }
    return [...inputs.values()];
}
