import type { SyntaxFeatures } from './analysis/syntax.js';

export interface SyntaxRow {
    scriptName: string;
    scriptHash: string;
    truncated: boolean;
    embedding: Float32Array;
    features: SyntaxFeatures;
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
    /// The JSON object of the `@dashql:properties` block
    properties: string;
    /// The embedded text, one `key: value` line per property
    text: string;
    truncated: boolean;
    embedding: Float32Array;
}
