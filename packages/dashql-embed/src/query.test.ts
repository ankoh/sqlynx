import { describe, expect, it } from 'vitest';
import { fuseScores } from './query.js';

const comments = new Map([
    ['a', { score: 0.9, text: 'a' }],
    ['b', { score: 0.5, text: 'b' }],
]);
const features = new Map([['a', 0.1], ['b', 0.8], ['c', 0.7]]);

describe('fuseScores', () => {
    it('weights both signals and falls back to the available one', () => {
        const out = fuseScores(comments, features, { fusion: 'weighted', weightComments: 0.6, weightFeatures: 0.4 });
        // c has no comments and keeps its feature score, a and b are weighted: 0.62 and 0.58
        expect(out.map(o => o.scriptName)).toEqual(['c', 'b', 'a']);
        expect(out[0]).toMatchObject({ scriptName: 'c', commentScore: null, score: 0.7 });
        expect(out[1].score).toBeCloseTo(0.62);
        expect(out[2].score).toBeCloseTo(0.58);
    });

    it('fuses ranks with RRF', () => {
        const out = fuseScores(comments, features, { fusion: 'rrf', weightComments: 0, weightFeatures: 0 });
        // b is second by comments and first by features, a is first and third
        expect(out[0].scriptName).toBe('b');
        expect(out[0].score).toBeCloseTo(1 / 62 + 1 / 61);
        expect(out.find(o => o.scriptName === 'c')!.score).toBeCloseTo(1 / 62);
    });
});
