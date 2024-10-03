import '@jest/globals';

import * as sqlynx from '../src/index.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';

const distPath = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const wasmPath = path.resolve(distPath, './sqlynx.wasm');

describe('SQLynx setup', () => {
    it('WebAssembly file exists', () => {
        expect(async () => await fs.promises.access(wasmPath)).resolves;
    });
    it('instantiates WebAssembly module', async () => {
        const instance = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
            const buf = await fs.promises.readFile(wasmPath);
            return await WebAssembly.instantiate(buf, imports);
        });
        expect(instance).not.toBeNull();
        expect(instance).not.toBeUndefined();
        const version = instance.getVersionText();
        expect(version).not.toBeFalsy();
        expect(version).toMatch(/^[0-9]+.[0-9]+.[0-9]+(\-dev\.[0-9]+)?$/);
    });
});

describe('ExternalObjectChildID', () => {
    it('create child ids', () => {
        const parentId = sqlynx.ExternalObjectID.create(1234, 5678);
        const childId = sqlynx.ExternalObjectChildID.create(parentId, 91011);
        expect(childId).not.toEqual(parentId);
        expect(sqlynx.ExternalObjectChildID.getParent(childId)).toEqual(parentId);
        expect(sqlynx.ExternalObjectChildID.getChild(childId)).toEqual(91011);
        expect(childId.toString()).toEqual("22763282211344411091843");
    });

});
