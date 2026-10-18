import type { StructureFeatures } from './analysis/structure.js';

/// The description of a script with its embedding. The structure and the metadata of the script are columns to filter by,
/// they are not embedded.
export interface IndexRow {
    scriptName: string;
    scriptHash: string;
    description: string;
    embedding: Float32Array;
    /// Null if the script could not be analyzed
    features: StructureFeatures | null;
    diagnostics: string[];
    /// The JSON object of the `@dashql:metadata` block, every key becomes a column. Null without a block.
    metadata: Record<string, unknown> | null;
}
