import { ATLAS_SIDECAR_FILE } from './files.js';
import type { EmbedderConfig } from './model.js';

/// Bumped whenever columns or semantics of the atlas files change
export const ATLAS_FORMAT_VERSION = 6;

/// Hyper writes Parquet without key-value metadata, so the sidecar carries how the vectors were made and which scripts
/// they cover.
export interface AtlasSidecar {
    formatVersion: number;
    embedder: EmbedderConfig;
    /// Version of the layouts: 3 coordinates per row in atlas_features_3d_{x,y,z} (features) and atlas_description_3d_{x,y,z} (comments), laid out independently
    layout: 'umap-3d' | 'none';
    layoutScales: { features: number; comments: number };
    /// script name -> sha256 of the script text at indexing time
    scripts: Record<string, string>;
    createdAt: string;
}

export function sidecarJson(sidecar: AtlasSidecar): string {
    return JSON.stringify(sidecar, null, 2) + '\n';
}

export async function writeSidecar(directory: FileSystemDirectoryHandle, sidecar: AtlasSidecar): Promise<void> {
    const handle = await directory.getFileHandle(ATLAS_SIDECAR_FILE, { create: true });
    const writable = await handle.createWritable();
    try {
        await writable.write(sidecarJson(sidecar));
    } finally {
        await writable.close();
    }
}

/// Read the sidecar, undefined if there is none or it cannot be understood
export async function readSidecar(directory: FileSystemDirectoryHandle): Promise<AtlasSidecar | undefined> {
    let text: string;
    try {
        text = await (await (await directory.getFileHandle(ATLAS_SIDECAR_FILE)).getFile()).text();
    } catch {
        return undefined;
    }
    try {
        return parseSidecar(JSON.parse(text));
    } catch {
        return undefined;
    }
}

export function parseSidecar(value: unknown): AtlasSidecar | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const v = value as Partial<AtlasSidecar>;
    if (v.formatVersion !== ATLAS_FORMAT_VERSION) return undefined;
    if (typeof v.embedder !== 'object' || v.embedder === null) return undefined;
    if (typeof v.scripts !== 'object' || v.scripts === null) return undefined;
    if (typeof v.layoutScales !== 'object' || v.layoutScales === null) return undefined;
    if (typeof v.layoutScales.features !== 'number' || typeof v.layoutScales.comments !== 'number') return undefined;
    return v as AtlasSidecar;
}

/// Can an index described by `sidecar` answer queries for these scripts without reindexing?
/// The embedder has to match exactly and the scripts have to be the same, with the same hashes. A deleted script
/// also means a reindex, so that no hit points to a file that is gone.
export function isIndexCurrent(
    sidecar: AtlasSidecar | undefined,
    embedder: EmbedderConfig,
    scripts: ReadonlyMap<string, string>,
): boolean {
    if (!sidecar) return false;
    const e = sidecar.embedder;
    if (
        e.model !== embedder.model ||
        e.dtype !== embedder.dtype ||
        e.pooling !== embedder.pooling ||
        e.queryPrefix !== embedder.queryPrefix ||
        e.documentPrefix !== embedder.documentPrefix ||
        e.maxTokens !== embedder.maxTokens ||
        e.dim !== embedder.dim
    ) {
        return false;
    }
    if (sidecar.scripts == null) return false;
    for (const [name, hash] of scripts) {
        if (sidecar.scripts[name] !== hash) return false;
    }
    return scripts.size === Object.keys(sidecar.scripts).length;
}
