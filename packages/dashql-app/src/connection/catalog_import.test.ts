import '@jest/globals';

import * as dashql from '@ankoh/dashql-core';
import * as pb from '@ankoh/dashql-protobuf';

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';

const distPath = path.resolve(fileURLToPath(new URL('../../../dashql-core-bindings/dist', import.meta.url)));
const wasmPath = path.resolve(distPath, './dashql.wasm');

let lnx: dashql.DashQL | null = null;

beforeAll(async () => {
    lnx = await dashql.DashQL.create(async (imports: WebAssembly.Imports) => {
        const buf = await fs.promises.readFile(wasmPath);
        return await WebAssembly.instantiate(buf, imports);
    });
    expect(lnx).not.toBeNull();
});

describe('Catalog Import', () => {
    it('foo', async () => {
        const catalog = lnx!.createCatalog();

        const workbookProto = new pb.dashql.workbook.Workbook();
        const catalogProto = new pb.dashql.file.FileCatalog(
        );

        const _fileProto = new pb.dashql.file.File({
            workbooks: [workbookProto],
            catalogs: [catalogProto],
        });

        catalog.delete();
    });
});

