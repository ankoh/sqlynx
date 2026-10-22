import { describe, it, expect } from 'vitest';

import { randomScriptName } from './script_name.js';

describe('randomScriptName', () => {
    it('produces an underscore-joined two-word lowercase name', () => {
        const name = randomScriptName(undefined, () => 0);
        expect(name).toMatch(/^[a-z]+_[a-z]+$/);
    });

    it('is deterministic for a given rng', () => {
        // A constant rng selects the first word from each list.
        const a = randomScriptName(undefined, () => 0);
        const b = randomScriptName(undefined, () => 0);
        expect(a).toBe(b);
        // Two words composed with an underscore.
        expect(a.split('_')).toHaveLength(2);
    });

    it('avoids names already taken when possible', () => {
        // rng cycles through a short sequence so the first pick collides and the retry differs.
        const seq = [0, 0, 0.5, 0.5];
        let i = 0;
        const rng = () => seq[i++ % seq.length];
        const first = randomScriptName(undefined, () => 0); // the "all-zero" name
        const taken = new Set([first]);
        const name = randomScriptName(taken, rng);
        expect(taken.has(name)).toBe(false);
    });

    it('still returns a name when every attempt collides', () => {
        // A constant rng can only ever produce one name; if it is taken, generation cannot avoid it.
        const only = randomScriptName(undefined, () => 0);
        const name = randomScriptName(new Set([only]), () => 0);
        // Falls back to the colliding name; callers (uniqueScriptBase) add the numeric suffix.
        expect(name).toBe(only);
    });
});
