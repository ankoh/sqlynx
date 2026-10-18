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

function parseMetadata(text: string): dashql.ScriptMetadata | null {
    const catalog = dql!.createCatalog();
    const script = dql!.createScript(catalog);
    script.insertTextAt(0, text);
    script.parse();
    const parsed = script.getParsed();
    const metadata = dashql.readMetadata(parsed.read(), encoder.encode(text));
    parsed.destroy();
    script.destroy();
    catalog.destroy();
    return metadata;
}

describe('Comment metadata', () => {
    it('renders pretty-printed JSON as line comments', () => {
        expect(dashql.renderMetadataBlock({ owner: 'finance', runtime_ms: 1834 })).toEqual(
            [
                '-- @dashql:metadata',
                '-- {',
                '--   "owner": "finance",',
                '--   "runtime_ms": 1834',
                '-- }',
                '-- @dashql:end',
            ].join('\n'),
        );
        expect(dashql.renderMetadataBlock({}, '\r\n')).toEqual('-- @dashql:metadata\r\n-- {}\r\n-- @dashql:end');
    });

    it('round-trips through the parser', () => {
        const metadata = {
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
            const text = `${dashql.renderMetadataBlock(metadata, eol)}${eol}${eol}select 1;${eol}`;
            expect(parseMetadata(text)).toEqual(metadata);
        }
    });

    it('reads hand-written block comments', () => {
        const text = '/* @dashql:metadata\n * {"owner": "finance",\n *  "tags": ["weekly"]}\n */\nselect 1;\n';
        expect(parseMetadata(text)).toEqual({ owner: 'finance', tags: ['weekly'] });
    });

    it('ignores scripts without valid metadata', () => {
        expect(parseMetadata('select 1;')).toBeNull();
        expect(parseMetadata('-- @dashql:metadata\n-- owner: finance\n-- @dashql:end\nselect 1;')).toBeNull();
        expect(parseMetadata('-- @dashql:metadata\n-- [1, 2]\n-- @dashql:end\nselect 1;')).toBeNull();
    });

    it('keeps metadata next to a description', () => {
        const text = [
            dashql.renderMetadataBlock({ owner: 'finance' }),
            '',
            '-- @dashql:description',
            '-- Revenue per segment.',
            '-- @dashql:end',
            'select 1;',
        ].join('\n');
        expect(parseMetadata(text)).toEqual({ owner: 'finance' });
    });
});
