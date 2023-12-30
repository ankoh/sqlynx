import '@jest/globals';

import * as sqlynx from '../src';
import path from 'path';
import fs from 'fs';

const distPath = path.resolve(__dirname, '../dist');
const wasmPath = path.resolve(distPath, './sqlynx.wasm');

let lnx: sqlynx.SQLynx | null = null;

beforeAll(async () => {
    lnx = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(lnx).not.toBeNull();
});

describe('SQLynx scripts', () => {
    it('can be created', () => {
        const script = lnx!.createScript(null, 1);
        expect(script).not.toBeUndefined();
        script.delete();
    });

    it('are initially empty', () => {
        const script = lnx!.createScript(null, 1);
        expect(script).not.toBeUndefined();
        expect(script.toString()).toEqual('');
        script.delete();
    });

    it('should throw for accesses after deletion', () => {
        const script = lnx!.createScript(null, 1);
        script.delete();
        expect(() => script.toString()).toThrow(sqlynx.NULL_POINTER_EXCEPTION);
        expect(() => script.insertTextAt(0, 'foo')).toThrow(sqlynx.NULL_POINTER_EXCEPTION);
        expect(() => script.eraseTextRange(0, 1)).toThrow(sqlynx.NULL_POINTER_EXCEPTION);
    });

    it('can be deleted repeatedly', () => {
        const script = lnx!.createScript(null, 1);
        expect(script).not.toBeUndefined();
        expect(script.toString()).toEqual('');
        script.delete();
        script.delete();
        script.delete();
    });

    describe('text modifications', () => {
        it('inserting a single character', () => {
            const script = lnx!.createScript(null, 1);
            script.insertTextAt(0, 'a');
            expect(script.toString()).toEqual('a');
            script.delete();
        });
    });
});
