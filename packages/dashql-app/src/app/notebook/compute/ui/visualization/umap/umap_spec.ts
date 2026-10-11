import type { UMAPOptions } from '@dashql/umap-wasm';

import type { UmapRequest } from '../../../../../../compute/umap/umap_projection.js';
import type * as buffers from '@ankoh/dashql-core/buffers';

/// Map the analyzer's projection sub-spec to UMAP options, applying UMAP's defaults
/// for anything the user left unspecified (metric cosine, nNeighbors 15, minDist 0.1).
function umapOptionsFromSpec(spec: buffers.visualization.UmapSpecT): UMAPOptions {
    const p = spec.projection;
    const options: UMAPOptions = {
        metric: p && typeof p.metric === 'string' && p.metric === 'euclidean' ? 'euclidean' : 'cosine',
    };
    if (typeof p?.neighbors === 'number') options.nNeighbors = p.neighbors;
    if (typeof p?.minDist === 'number') options.minDist = p.minDist;
    return options;
}

/// Build the compute-layer projection request from a resolved UMAP spec. The
/// view/notebook layer calls this at execute sites to attach `projection` to the
/// query so `analyzeTable` computes the coordinates as a post-processing step.
export function umapRequestFromSpec(spec: buffers.visualization.UmapSpecT): UmapRequest | undefined {
    if (typeof spec.vectorColumn !== 'string' || spec.vectorColumn.length === 0) return undefined;
    return { vectorColumn: spec.vectorColumn, options: umapOptionsFromSpec(spec) };
}
