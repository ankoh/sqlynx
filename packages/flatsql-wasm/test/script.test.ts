import '@jest/globals';

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

describe('FlatSQL scripts', () => {
    it('can be created', () => {
        const script = fsql!.createScript(1);
        expect(script).not.toBeUndefined();
        script.delete();
    });

    it('are initially empty', () => {
        const script = fsql!.createScript(1);
        expect(script).not.toBeUndefined();
        expect(script.toString()).toEqual('');
        script.delete();
    });

    it('should throw for accesses after deletion', () => {
        const script = fsql!.createScript(1);
        script.delete();
        expect(() => script.toString()).toThrow(flatsql.NULL_POINTER_EXCEPTION);
        expect(() => script.insertTextAt(0, 'foo')).toThrow(flatsql.NULL_POINTER_EXCEPTION);
        expect(() => script.eraseTextRange(0, 1)).toThrow(flatsql.NULL_POINTER_EXCEPTION);
    });

    it('can be deleted repeatedly', () => {
        const script = fsql!.createScript(1);
        expect(script).not.toBeUndefined();
        expect(script.toString()).toEqual('');
        script.delete();
        script.delete();
        script.delete();
    });

    describe('text modifications', () => {
        it('inserting a single character', () => {
            const script = fsql!.createScript(1);
            script.insertTextAt(0, 'a');
            expect(script.toString()).toEqual('a');
            script.delete();
        });
    });
});
