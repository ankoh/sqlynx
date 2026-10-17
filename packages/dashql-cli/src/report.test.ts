import { describe, expect, it } from 'vitest';
import type { Diagnostic } from './lint.js';
import { formatFile, formatSummary } from './report.js';

const parseError: Diagnostic = {
    file: 'q.sql',
    line: 2,
    column: 11,
    stage: 'parse',
    severity: 'error',
    message: 'syntax error, unexpected SEMICOLON',
    offset: 20,
    length: 1,
};

describe('formatFile', () => {
    it('shows diagnostics with the underlined source line', () => {
        const text = 'select 1;\nselect 1 +;\n';
        expect(formatFile({ file: 'q.sql', text, diagnostics: [parseError], execution: 'skipped' })).toBe(
            [
                'q.sql',
                '  2:11  error    parse    syntax error, unexpected SEMICOLON',
                '        │ select 1 +;',
                '        │           ^',
                '        skipped  execute  not executed due to errors',
            ].join('\n'),
        );
    });

    it('underlines the whole span in code points', () => {
        const text = "select 'ä' + bogus;";
        const d: Diagnostic = { ...parseError, line: 1, column: 14, offset: 14, length: 5, stage: 'analyze', severity: 'warning', message: 'hm' };
        expect(formatFile({ file: 'q.sql', text, diagnostics: [d] }).split('\n').slice(2)).toEqual([
            "        │ select 'ä' + bogus;",
            '        │              ^^^^^',
        ]);
    });

    it('counts statements and rows of executed scripts', () => {
        expect(formatFile({ file: 'q.sql', text: '', diagnostics: [], execution: { ok: true, statements: 3, rows: 1 } })).toBe(
            'q.sql\n    ok       execute  3 statements, 1 row',
        );
        expect(formatFile({ file: 'q.sql', text: '', diagnostics: [], execution: { ok: true, statements: 1 } })).toBe(
            'q.sql\n    ok       execute  1 statement, no result',
        );
    });

    it('shows execution errors with their SQL state, detail and hint', () => {
        const execution = {
            ok: false as const,
            statement: 2,
            message: 'table "missing" does not exist',
            sqlState: '42P01',
            detail: '\nline 1, column 15: select * from missing\n                                  ^~~~~~~',
            hint: 'create it first',
        };
        expect(formatFile({ file: 'q.sql', text: '', diagnostics: [], execution })).toBe(
            [
                'q.sql',
                '    error    execute  statement 2: table "missing" does not exist [42P01]',
                '                      line 1, column 15: select * from missing',
                '                                                        ^~~~~~~',
                '                      hint: create it first',
            ].join('\n'),
        );
    });
});

describe('formatSummary', () => {
    it('counts files, errors, warnings and executed scripts', () => {
        expect(formatSummary({ files: 1, errors: 0, warnings: 2 })).toBe('1 file, 0 errors, 2 warnings');
        expect(formatSummary({ files: 3, errors: 1, warnings: 0, executed: 2 })).toBe('3 files, 1 error, 0 warnings, 2 executed');
    });
});
