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

const encoder = new TextEncoder();

function parseProperties(text: string): dashql.ScriptProperties | null {
    const catalog = dql!.createCatalog();
    const script = dql!.createScript(catalog);
    script.insertTextAt(0, text);
    script.parse();
    const parsed = script.getParsed();
    const properties = dashql.readProperties(parsed.read(), encoder.encode(text));
    parsed.destroy();
    script.destroy();
    catalog.destroy();
    return properties;
}

describe('Comment properties', () => {
    it('renders pretty-printed JSON as line comments', () => {
        expect(dashql.renderPropertiesBlock({ owner: 'finance', runtime_ms: 1834 })).toEqual(
            [
                '-- @dashql:properties',
                '-- {',
                '--   "owner": "finance",',
                '--   "runtime_ms": 1834',
                '-- }',
                '-- @dashql:end',
            ].join('\n'),
        );
        expect(dashql.renderPropertiesBlock({}, '\r\n')).toEqual('-- @dashql:properties\r\n-- {}\r\n-- @dashql:end');
    });

    it('round-trips through the parser', () => {
        const properties = {
            owner: 'finance',
            notes: 'first line\nsecond line\r\n\tindented',
            quotes: 'say "hi" */ -- not a comment',
            tag: '@dashql:end',
            '@dashql:end': -1,
            unicode: 'Grüße 👋  ',
            empty: '',
            padded: '  spaces  ',
            nested: { list: [1, 'two', null, { three: true }], negative: -0.5 },
            flag: false,
            nothing: null,
        };
        for (const eol of ['\n', '\r\n']) {
            const text = `${dashql.renderPropertiesBlock(properties, eol)}${eol}${eol}select 1;${eol}`;
            expect(parseProperties(text)).toEqual(properties);
        }
    });

    it('reads hand-written block comments', () => {
        const text = '/* @dashql:properties\n * {"owner": "finance",\n *  "tags": ["weekly"]}\n */\nselect 1;\n';
        expect(parseProperties(text)).toEqual({ owner: 'finance', tags: ['weekly'] });
    });

    it('ignores scripts without valid properties', () => {
        expect(parseProperties('select 1;')).toBeNull();
        expect(parseProperties('-- @dashql:properties\n-- owner: finance\n-- @dashql:end\nselect 1;')).toBeNull();
        expect(parseProperties('-- @dashql:properties\n-- [1, 2]\n-- @dashql:end\nselect 1;')).toBeNull();
    });

    it('keeps properties next to a description', () => {
        const text = [
            dashql.renderPropertiesBlock({ owner: 'finance' }),
            '',
            '-- @dashql:description',
            '-- Revenue per segment.',
            '-- @dashql:end',
            'select 1;',
        ].join('\n');
        expect(parseProperties(text)).toEqual({ owner: 'finance' });
    });
});
