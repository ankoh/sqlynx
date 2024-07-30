import '@jest/globals';

import * as sqlynx from '../src/index.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';

const distPath = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
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
        const catalog = lnx!.createCatalog();
        const script = lnx!.createScript(catalog, 1);
        expect(script).not.toBeUndefined();
        script.delete();
        catalog.delete();
    });

    it('are initially empty', () => {
        const catalog = lnx!.createCatalog();
        const script = lnx!.createScript(catalog, 1);
        expect(script).not.toBeUndefined();
        expect(script.toString()).toEqual('');
        script.delete();
        catalog.delete();
    });

    it('should throw for accesses after deletion', () => {
        const catalog = lnx!.createCatalog();
        const script = lnx!.createScript(catalog, 1);
        script.delete();
        catalog.delete();
        expect(() => script.toString()).toThrow(sqlynx.NULL_POINTER_EXCEPTION);
        expect(() => script.insertTextAt(0, 'foo')).toThrow(sqlynx.NULL_POINTER_EXCEPTION);
        expect(() => script.eraseTextRange(0, 1)).toThrow(sqlynx.NULL_POINTER_EXCEPTION);
    });

    it('can be deleted repeatedly', () => {
        const catalog = lnx!.createCatalog();
        const script = lnx!.createScript(catalog, 1);
        expect(script).not.toBeUndefined();
        expect(script.toString()).toEqual('');
        script.delete();
        script.delete();
        script.delete();
        catalog.delete();
    });

    describe('text modifications', () => {
        it('inserting a single character', () => {
            const catalog = lnx!.createCatalog();
            const script = lnx!.createScript(catalog, 1);
            script.insertTextAt(0, 'a');
            expect(script.toString()).toEqual('a');
            script.delete();
            catalog.delete();
        });
    });
});
