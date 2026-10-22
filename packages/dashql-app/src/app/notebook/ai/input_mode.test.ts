import * as core from '@ankoh/dashql-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assessSql, ComposerInputMode, decideMode } from './input_mode.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: core.DashQL;
let catalog: core.DashQLCatalog;
let session: core.DashQLScriptSession;
beforeAll(async () => {
    dql = await core.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
    catalog = dql.createCatalog();
    session = dql.createScriptSession(catalog);
});
afterAll(() => {
    session.destroy();
    catalog.destroy();
    dql.resetUnsafe();
});

/// Analyze a text in the draft session
function analyze(text: string): core.buffers.editor.EditorUpdateT {
    session.replaceText(session.getTextVersion(), text);
    return session.analyze();
}

/// Type a text character by character and record the mode after every keystroke
function replay(text: string, mode = ComposerInputMode.Ai): Map<string, ComposerInputMode> {
    const modes = new Map<string, ComposerInputMode>();
    for (let i = 1; i <= text.length; ++i) {
        const prefix = text.substring(0, i);
        mode = decideMode(mode, assessSql(analyze(prefix), i));
        modes.set(prefix, mode);
    }
    return modes;
}

const { Ai, Sql } = ComposerInputMode;

describe('assessSql', () => {
    it('ignores the token that is still being typed', () => {
        expect(assessSql(analyze('sel'), 3)).toMatchObject({ leadingKeyword: false, validTokens: 0, tailTokens: 0 });
        expect(assessSql(analyze('select 1'), 8)).toMatchObject({ leadingKeyword: true, validTokens: 1, tailTokens: 0 });
        expect(assessSql(analyze('select 1'), null)).toMatchObject({ validTokens: 2, validSqlTokens: 1, tailTokens: 0, complete: true });
    });

    it('treats an error at the end of the input as a viable prefix', () => {
        expect(assessSql(analyze('select (1 + '), 12)).toMatchObject({ validTokens: 4, tailTokens: 0 });
    });

    it('splits the tokens at the first error', () => {
        expect(assessSql(analyze('select 1 2 '), 11)).toMatchObject({ validTokens: 2, tailTokens: 1, tailSqlWeight: 1 });
        // SHOW is no statement of the DashQL grammar
        expect(assessSql(analyze('show me the revenue '), 20)).toMatchObject({
            leadingKeyword: true, validTokens: 0, tailTokens: 4, tailSqlWeight: 0.5,
        });
    });

    it('skips comments', () => {
        expect(assessSql(analyze('-- c\nselect 1'), null)).toMatchObject({ leadingKeyword: true, validTokens: 2, tailTokens: 0 });
    });
});

describe('decideMode', () => {
    it('stays in natural language for questions', () => {
        expect(replay('what is the revenue ').get('what is the revenue ')).toBe(Ai);
        expect(replay('create a chart of sales ').get('create a chart of sales ')).toBe(Ai);
    });

    it('needs more than a lone keyword to switch to SQL', () => {
        const modes = replay('select 1 ');
        expect(modes.get('select ')).toBe(Ai);
        expect(modes.get('select 1')).toBe(Ai);
        expect(modes.get('select 1 ')).toBe(Sql);
    });

    it('accepts a complete statement when the draft is sent', () => {
        expect(decideMode(Ai, assessSql(analyze('select 1'), null), true)).toBe(Sql);
        expect(decideMode(Ai, assessSql(analyze('select * from orders'), null), true)).toBe(Sql);
        expect(decideMode(Ai, assessSql(analyze('show me the revenue'), null), true)).toBe(Ai);
        expect(decideMode(Ai, assessSql(analyze('what is it'), null), true)).toBe(Ai);
    });

    it('never takes questions that start with a keyword for SQL', () => {
        const modes = replay('show me the revenue of all customers ');
        expect([...modes.values()].every(mode => mode === Ai)).toBe(true);
    });

    it('hesitates before leaving SQL for a short valid prefix', () => {
        // "what" is an alias, "was" is the first error
        const modes = replay('select 1 what was the revenue ');
        expect(modes.get('select 1 ')).toBe(Sql);
        expect(modes.get('select 1 what was ')).toBe(Sql);
        expect(modes.get('select 1 what was the ')).toBe(Ai);
    });

    it('stays in SQL while a statement is edited', () => {
        const modes = replay('select a, b from orders wher x');
        for (const [prefix, mode] of modes) {
            if (prefix.length >= 'select a, '.length) expect(mode, prefix).toBe(Sql);
        }
        const query = 'select a, b, c from orders o join customers c on o.customer = c.id where o.amount > 10 and c.name = \'x\'';
        const broken = query.replace('from orders', 'frm orders');
        expect(decideMode(Sql, assessSql(analyze(broken), null))).toBe(Sql);
    });

    it('leaves a long SQL prefix only for a longer sentence', () => {
        const query = 'select a from orders where amount > 10 ';
        const modes = replay(`${query}and then tell me which of them are the biggest ones please `, Sql);
        expect(modes.get(`${query}and then tell `)).toBe(Sql);
        expect(modes.get(`${query}and then tell me which of them are the biggest ones please `)).toBe(Ai);
    });
});
