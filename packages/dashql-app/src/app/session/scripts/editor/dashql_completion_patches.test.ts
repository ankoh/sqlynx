import { describe, it, expect } from 'vitest';
import { completionDiff, CompletionPatchTarget, TextAnchor, PATCH_INSERT_TEXT, PATCH_DELETE_TEXT } from './dashql_completion_patches.js';

const T = CompletionPatchTarget.Candidate;

describe('completionDiff', () => {
    it('substring match: inserts before and after', () => {
        // "att" is a substring of "hyper_attached_database"
        //  want: "hyper_att[ached_database]"  have: "att"
        const patches = completionDiff(10, 'att', 'hyper_attached_database', T, 13);
        expect(patches).toEqual([
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 10, text: 'hyper_', textAnchor: TextAnchor.Right } },
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 13, text: 'ached_database', textAnchor: TextAnchor.Left } },
        ]);
    });

    it('substring match: prefix only', () => {
        // "database" appears at the end of "hyper_attached_database"
        const patches = completionDiff(0, 'database', 'hyper_attached_database', T, 8);
        expect(patches).toEqual([
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 0, text: 'hyper_attached_', textAnchor: TextAnchor.Right } },
        ]);
    });

    it('substring match: suffix only', () => {
        // "hyper" appears at the start of "hyper_attached_database"
        const patches = completionDiff(5, 'hyper', 'hyper_attached_database', T, 10);
        expect(patches).toEqual([
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 10, text: '_attached_database', textAnchor: TextAnchor.Left } },
        ]);
    });

    it('no substring match: delete and insert after', () => {
        // "xyz" is not a substring of "hyper_attached_database"
        const patches = completionDiff(10, 'xyz', 'hyper_attached_database', T, 13);
        expect(patches).toEqual([
            { target: T, type: PATCH_DELETE_TEXT, value: { at: 10, length: 3 } },
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 13, text: 'hyper_attached_database', textAnchor: TextAnchor.Left } },
        ]);
    });

    it('empty have: full insert', () => {
        const patches = completionDiff(10, '', 'hyper_attached_database', T, 10);
        expect(patches).toEqual([
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 10, text: 'hyper_attached_database', textAnchor: TextAnchor.Left } },
        ]);
    });

    it('exact match: no patches', () => {
        const patches = completionDiff(10, 'hello', 'hello', T, 15);
        expect(patches).toEqual([]);
    });

    it('uses first occurrence for substring match', () => {
        // "a" appears multiple times in "banana", matches at index 1
        const patches = completionDiff(0, 'a', 'banana', T, 1);
        expect(patches).toEqual([
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 0, text: 'b', textAnchor: TextAnchor.Right } },
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 1, text: 'nana', textAnchor: TextAnchor.Left } },
        ]);
    });

    it('quoted identifier: have is a substring inside quotes', () => {
        // "attr" appears at index 1 inside '"attrA"'
        const patches = completionDiff(10, 'attr', '"attrA"', T, 14);
        expect(patches).toEqual([
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 10, text: '"', textAnchor: TextAnchor.Right } },
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 14, text: 'A"', textAnchor: TextAnchor.Left } },
        ]);
    });

    it('quoted identifier: have includes opening quote', () => {
        // '"attr' is a substring of '"attrA"'
        const patches = completionDiff(10, '"attr', '"attrA"', T, 15);
        expect(patches).toEqual([
            { target: T, type: PATCH_INSERT_TEXT, value: { at: 15, text: 'A"', textAnchor: TextAnchor.Left } },
        ]);
    });
});
