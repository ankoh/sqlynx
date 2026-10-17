import { beforeAll, describe, expect, it } from 'vitest';
import { Linter, formatDiagnostics, lineColumn, type Diagnostic } from './lint.js';

let linter: Linter;
beforeAll(async () => {
    linter = await Linter.create();
});

const lintOne = (text: string, l: Linter = linter) => l.lint([{ id: 'test.sql', text }]);

describe('lineColumn', () => {
    const bytes = new TextEncoder().encode('ab\näöc\nx');
    it('resolves byte offsets to lines and code point columns', () => {
        expect(lineColumn(bytes, 0)).toEqual({ line: 1, column: 1 });
        expect(lineColumn(bytes, 3)).toEqual({ line: 2, column: 1 });
        // ä and ö take two bytes each
        expect(lineColumn(bytes, 7)).toEqual({ line: 2, column: 3 });
        expect(lineColumn(bytes, 9)).toEqual({ line: 3, column: 1 });
    });
});

describe('Linter', () => {
    it('reports nothing for a clean script', () => {
        expect(lintOne('select 1;\nselect a from b where c = 42;')).toEqual([]);
    });

    it('reports scanner errors', () => {
        const diagnostics = lintOne("select 'unterminated");
        expect(diagnostics.some(d => d.stage === 'scan' && d.severity === 'error')).toBe(true);
    });

    it('reports parser errors with their position', () => {
        const diagnostics = lintOne('select 1;\nselect 1 +;');
        const parse = diagnostics.filter(d => d.stage === 'parse');
        expect(parse.length).toBeGreaterThan(0);
        expect(parse[0]).toMatchObject({ file: 'test.sql', severity: 'error', line: 2, column: 11 });
        expect(parse[0].message).not.toBe('');
    });

    it('reports analyzer errors against a schema', async () => {
        const withSchema = await Linter.create();
        expect(
            withSchema.addSchema({ id: 'schema.sql', text: 'create table a (id integer); create table b (id integer);' }),
        ).toEqual([]);
        const diagnostics = lintOne('select id from a, b;', withSchema);
        expect(diagnostics).toEqual([expect.objectContaining({ stage: 'analyze', severity: 'error', line: 1, column: 8 })]);
    });
});

describe('formatDiagnostics', () => {
    const diagnostics: Diagnostic[] = [
        { file: 'a.sql', line: 1, column: 2, stage: 'parse', severity: 'error', message: 'oops', offset: 1, length: 3 },
        { file: 'b.sql', stage: 'failure', severity: 'error', message: 'boom' },
    ];

    it('writes one diagnostic per line as a JSON array', () => {
        const text = formatDiagnostics(diagnostics);
        expect(text).toBe(
            '[\n' +
                '{"file":"a.sql","line":1,"column":2,"stage":"parse","severity":"error","message":"oops","offset":1,"length":3},\n' +
                '{"file":"b.sql","stage":"failure","severity":"error","message":"boom"}\n' +
                ']\n',
        );
        expect(JSON.parse(text)).toEqual(diagnostics);
    });

    it('writes an empty array without diagnostics', () => {
        expect(JSON.parse(formatDiagnostics([]))).toEqual([]);
    });
});
