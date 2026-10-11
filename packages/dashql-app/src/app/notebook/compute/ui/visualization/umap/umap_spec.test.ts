import { describe, expect, it } from 'vitest';

import { buffers } from '@ankoh/dashql-core';
import { umapRequestFromSpec } from './umap_spec.js';

const Projection = buffers.visualization.UmapProjectionSpecT;
const Spec = buffers.visualization.UmapSpecT;

describe('umapRequestFromSpec', () => {
    it('maps generated FlatBuffer objects to compute options', () => {
        const projection = new Projection();
        projection.metric = 'euclidean';
        projection.neighbors = 20;
        projection.minDist = 0.25;

        const spec = new Spec();
        spec.vectorColumn = 'embedding';
        spec.projection = projection;

        expect(umapRequestFromSpec(spec)).toEqual({
            vectorColumn: 'embedding',
            options: {
                metric: 'euclidean',
                nNeighbors: 20,
                minDist: 0.25,
            },
        });
    });

    it('rejects a missing vector column and applies projection defaults', () => {
        expect(umapRequestFromSpec(new Spec())).toBeUndefined();

        const spec = new Spec();
        spec.vectorColumn = 'embedding';
        expect(umapRequestFromSpec(spec)).toEqual({
            vectorColumn: 'embedding',
            options: { metric: 'cosine' },
        });
    });
});
