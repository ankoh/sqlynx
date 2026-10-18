import type { StructureFeatures } from './analysis/structure.js';

/// One chunk of the description of a script. The structure and the metadata of the script are repeated on every chunk,
/// they are columns to filter by and are not embedded.
export interface IndexRow {
    scriptName: string;
    scriptHash: string;
    chunkIndex: number;
    text: string;
    embedding: Float32Array;
    /// Null if the script could not be analyzed
    features: StructureFeatures | null;
    diagnostics: string[];
    /// The JSON object of the `@dashql:metadata` block, every key becomes a column. Null without a block.
    metadata: Record<string, unknown> | null;
}
