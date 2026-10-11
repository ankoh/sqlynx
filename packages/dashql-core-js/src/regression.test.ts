import * as dashql from './index.js';

import { loadCoreWasm } from './test_fixture.js';

let dql: dashql.DashQL | null = null;
beforeAll(async () => {
    const wasmBinary = await loadCoreWasm();
    dql = await dashql.DashQL.create({ wasmBinary });
    expect(dql).not.toBeNull();
});
afterEach(async () => {
    dql!.resetUnsafe();
});

describe('Regression Tests ', () => {
    it('dynamic registration, one table', () => {
        const catalog = dql!.createCatalog();
        {
            const script = dql!.createScript(catalog);
            script.replaceText('select 1');
            script.parse();
        }
        {
            const script = dql!.createScript(catalog);
            script.replaceText('select 1');
            script.parse();
        }
    });
});
