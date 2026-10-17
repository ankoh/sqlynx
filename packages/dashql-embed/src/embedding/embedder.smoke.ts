import { describe, expect, it } from 'vitest';
import { TransformersEmbedder, cosine } from './embedder.js';

describe('default model', () => {
    it('produces normalized 384-dimensional vectors and ranks related text higher', async () => {
        const embedder = await TransformersEmbedder.create({});
        expect(embedder.dim).toBe(384);
        expect(embedder.config.maxTokens).toBe(512);
        const [doc, other] = await embedder.embedDocuments([
            'Tables: customer, orders. Joins: customer.c_custkey = orders.o_custkey. Aggregates: sum.',
            'Statements: 1 create table statement. Tables: weather_station.',
        ]);
        expect(cosine(doc, doc)).toBeCloseTo(1, 4);
        const query = await embedder.embedQuery('total order value per customer');
        expect(cosine(query, doc)).toBeGreaterThan(cosine(query, other));
        expect(embedder.countTokens('select 1')).toBeGreaterThan(2);
    });
});
