import { readFile } from 'node:fs/promises';
import type { EmbedderConfig } from '../embedding/embedder.js';
import { layoutColumns, layoutKind, readParquetFile } from '../output/parquet.js';
import { layoutKey, type LayoutDims, type PreviousLayout } from './layout.js';

/// Read the layout of an earlier `index` run. Undefined when there is none, when it came from another model, since
/// the coordinates only mean something for the embeddings they were made from, or when it has other dimensions.
export async function readPreviousLayout(
    path: string,
    config: EmbedderConfig,
    dim: number,
    dims: LayoutDims,
): Promise<PreviousLayout | undefined> {
    try {
        await readFile(path);
    } catch {
        return undefined;
    }
    try {
        const file = await readParquetFile(path);
        const scale = Number(file.metadata.get('dashql_embed.layout_scale'));
        const columns = layoutColumns(dims).map(name => file.table.getChild(name));
        if (file.metadata.get('dashql_embed.layout') !== layoutKind(dims) || !(scale > 0) || columns.some(c => !c)) return undefined;
        if (file.dim !== dim || file.metadata.get('dashql_embed.model') !== config.model) return undefined;
        const names = file.table.getChild('script_name')!;
        const hashes = file.table.getChild('script_hash')!;
        const coords = new Map<string, number[]>();
        for (let i = 0; i < file.table.numRows; ++i) {
            coords.set(layoutKey(names.get(i), hashes.get(i)), columns.map(c => c!.get(i) as number));
        }
        return { coords, scale };
    } catch {
        return undefined;
    }
}
