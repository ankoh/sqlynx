import '@jest/globals';

import { cyrb128, xoshiro128ss } from './rand';
import * as flatsql from '../src';
import path from 'path';
import fs from 'fs';

const distPath = path.resolve(__dirname, '../dist');
const wasmPath = path.resolve(distPath, './flatsql.wasm');

let fsql: flatsql.FlatSQL | null = null;

beforeAll(async () => {
    fsql = await flatsql.FlatSQL.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(fsql).not.toBeNull();
});

/// A type of an interaction
enum ScriptInteractionType {
    Insert,
    Remove,
}
/// A single user interaction
class ScriptInteraction {
    /// The input operation tyep
    type: ScriptInteractionType;
    /// The begin of the operation
    begin: number;
    /// The operation size
    count: number;

    constructor(type: ScriptInteractionType, begin: number, count: number) {
        this.type = type;
        this.begin = begin;
        this.count = count;
    }

    /// Apply the input operation to a string buffer
    public applyToText(buffer: string, data: string): string {
        switch (this.type) {
            case ScriptInteractionType.Insert:
                return buffer.substring(0, this.begin) + data.substring(0, this.count) + buffer.substring(this.begin);
            case ScriptInteractionType.Remove:
                return buffer.substring(0, this.begin) + buffer.substring(this.begin + this.count);
        }
    }
    /// Apply the input operation to a rope
    public applyToScript(script: flatsql.FlatSQLScript, data: string) {
        switch (this.type) {
            case ScriptInteractionType.Insert:
                script.insertTextAt(this.begin, data.substring(0, this.count));
                break;
            case ScriptInteractionType.Remove:
                script.eraseTextRange(this.begin, this.count);
                break;
        }
    }
    /// Print the interaction as string
    public toString() {
        const name = this.type == ScriptInteractionType.Insert ? 'insert' : 'remove';
        return name + '(' + this.begin + ',' + this.count + ')';
    }
}

class ScriptInteractionGenerator {
    /// The seeded data generator
    rng: () => number;
    /// The current data source
    dataSource: string;
    /// The current buffer size
    currentBufferSize: number;

    private rand() {
        return Math.floor(this.rng() * 0xffffffff);
    }

    /// Constructor
    private constructor(seedNumber: number, maxBytes: number) {
        let seed = cyrb128(seedNumber);
        this.currentBufferSize = 0;
        this.dataSource = '';
        this.rng = xoshiro128ss(seed[0], seed[1], seed[2], seed[3]);
        for (let i = 0; i < maxBytes; ++i) {
            this.dataSource += String.fromCharCode(48 + (this.rand() % (57 - 48)));
        }
    }
    /// Generate the next edit
    private generateOne(): ScriptInteraction {
        const begin = this.currentBufferSize == 0 ? 0 : this.rand() % this.currentBufferSize;
        console.assert(begin <= this.currentBufferSize);
        if ((this.rand() & 0b1) == 0) {
            const count = this.rand() % this.dataSource.length;
            this.currentBufferSize += count;
            return new ScriptInteraction(ScriptInteractionType.Insert, begin, count);
        } else {
            const end = begin + (begin == this.currentBufferSize ? 0 : this.rand() % (this.currentBufferSize - begin));
            console.assert(end - begin <= this.currentBufferSize);
            this.currentBufferSize -= end - begin;
            return new ScriptInteraction(ScriptInteractionType.Remove, begin, end - begin);
        }
    }

    /// Generate multiple input operations
    public static generateMany(seed: number, n: number, maxBytes: number): [ScriptInteraction[], string] {
        const gen = new ScriptInteractionGenerator(seed, maxBytes);
        const out: ScriptInteraction[] = [];
        for (let i = 0; i < n; ++i) {
            out.push(gen.generateOne());
        }
        return [out, gen.dataSource];
    }
}

describe('FlatSQL fuzzer', () => {
    for (let seed = 0; seed < 100; ++seed) {
        it('script interaction sequence', () => {
            const [ops, dataSource] = ScriptInteractionGenerator.generateMany(seed, 100, 100);
            const script = fsql!.createScript();
            let expected = '';
            for (let i = 0; i < ops.length; ++i) {
                expected = ops[i].applyToText(expected, dataSource);
                ops[i].applyToScript(script, dataSource);
                const have = script.toString();
                expect(have).toEqual(expected);
            }
            script.delete();
        });
    }
});
