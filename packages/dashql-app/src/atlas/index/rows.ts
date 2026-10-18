import type { CommentSource } from './analysis/comments.js';
import type { ScriptFeatures } from './analysis/features.js';

export interface CommentRow {
    scriptName: string;
    scriptHash: string;
    chunkIndex: number;
    source: CommentSource;
    text: string;
    embedding: Float32Array;
}

export interface FeatureRow {
    scriptName: string;
    scriptHash: string;
    truncated: boolean;
    embedding: Float32Array;
    features: ScriptFeatures;
    diagnostics: string[];
}
