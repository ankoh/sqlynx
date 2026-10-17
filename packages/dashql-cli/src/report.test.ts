import { describe, expect, it } from 'vitest';
import type { Diagnostic } from './lint.js';
import { duration, formatFile, formatSummary, formatTimings } from './report.js';

const timings = { core: 0, statements: [] };

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
        expect(formatFile({ file: 'q.sql', text: '', diagnostics: [], execution: { ok: true, statements: 3, rows: 1, timings } })).toBe(
            'q.sql\n    ok       execute  3 statements, 1 row',
        );
        expect(formatFile({ file: 'q.sql', text: '', diagnostics: [], execution: { ok: true, statements: 1, timings } })).toBe(
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
            timings,
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

describe('debug timings', () => {
    it('shows dashql-core and every Hyper statement of a script', () => {
        const execution = {
            ok: true as const,
            statements: 2,
            rows: 3,
            timings: {
                core: 4.2,
                statements: [
                    { wall: 812, hyper: { elapsed: 800, parsing: 0.4, compilation: 3, execution: 790 } },
                    { wall: 1500, hyper: { elapsed: 1490, parsing: 1, compilation: 10, execution: 1460 } },
                ],
            },
        };
        const report = { file: 'q.sql', text: '', diagnostics: [], execution };
        expect(formatFile(report)).toBe('q.sql\n    ok       execute  2 statements, 3 rows');
        expect(formatFile(report, undefined, true).split('\n').slice(2)).toEqual([
            '    debug    core     analyze and compile 4 ms',
            '    debug    hyper    statement 1: 812 ms (parse 0 ms, compile 3 ms, execute 790 ms)',
            '    debug    hyper    statement 2: 1.5 s (parse 1 ms, compile 10 ms, execute 1.5 s)',
        ]);
    });

    it('sums up a run', () => {
        const run = {
            coreStartup: 120,
            hyperStartup: 1100,
            lint: 42,
            compile: 63,
            hyperWall: 15300,
            hyperParsing: 10,
            hyperCompilation: 600,
            hyperExecution: 14200,
            statements: 80,
        };
        expect(formatTimings(run)).toBe(
            [
                'startup      dashql-core 120 ms, hyper 1.1 s',
                'dashql-core  scan, parse and analyze 42 ms, compile 63 ms',
                'hyper        80 statements 15.3 s: parse 10 ms, compile 600 ms, execute 14.2 s',
            ].join('\n'),
        );
        expect(formatTimings({ ...run, hyperStartup: undefined })).toBe(
            'startup      dashql-core 120 ms\ndashql-core  scan, parse and analyze 42 ms',
        );
    });

    it('formats durations', () => {
        expect(duration(0.4)).toBe('0 ms');
        expect(duration(999)).toBe('999 ms');
        expect(duration(1250)).toBe('1.3 s');
        expect(duration(null)).toBe('-');
    });
});
