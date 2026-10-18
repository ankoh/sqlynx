import { describe, expect, it } from 'vitest';
import { chunkText } from './chunking.js';

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

describe('chunkText', () => {
    it('keeps short text in one chunk', () => {
        expect(chunkText('  hello world  ', 10, words)).toEqual(['hello world']);
        expect(chunkText('   ', 10, words)).toEqual([]);
    });

    it('splits at paragraph boundaries first', () => {
        const text = 'one two three\n\nfour five six\n\nseven eight nine';
        expect(chunkText(text, 6, words)).toEqual(['one two three\nfour five six', 'seven eight nine']);
    });

    it('falls back to sentences and words for oversized units', () => {
        const text = 'a b c d e. f g h i j. k l m';
        const chunks = chunkText(text, 5, words);
        expect(chunks.every(c => words(c) <= 5)).toBe(true);
        expect(chunks.join(' ')).toContain('k l m');
        const long = chunkText('w '.repeat(23).trim(), 5, words);
        expect(long.every(c => words(c) <= 5)).toBe(true);
        expect(long.join(' ').split(/\s+/)).toHaveLength(23);
    });

    it('adds trailing context of the previous chunk as overlap', () => {
        const text = 'a b\n\nc d\n\ne f';
        expect(chunkText(text, 4, words, 2)).toEqual(['a b\nc d', 'c d\ne f']);
    });
});
