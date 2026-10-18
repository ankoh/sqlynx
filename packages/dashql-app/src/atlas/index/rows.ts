import type { StructureFeatures } from './analysis/structure.js';

export interface StructureRow {
    scriptName: string;
    scriptHash: string;
    truncated: boolean;
    embedding: Float32Array;
    features: StructureFeatures;
    diagnostics: string[];
}

export interface DescriptionRow {
    scriptName: string;
    scriptHash: string;
    chunkIndex: number;
    text: string;
    embedding: Float32Array;
}

export interface PropertiesRow {
    scriptName: string;
    scriptHash: string;
    /// The JSON object of the `@dashql:properties` block, every key becomes a column of the properties file
    properties: Record<string, unknown>;
    /// The embedded text, one `key: value` line per property
    text: string;
    truncated: boolean;
    embedding: Float32Array;
}
