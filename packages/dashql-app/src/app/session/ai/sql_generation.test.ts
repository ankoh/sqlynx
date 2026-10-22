import * as core from '@ankoh/dashql-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    buildSchemaContext,
    buildSqlGenerationMessages,
    describeSqlDialect,
    extractSql,
    generateSqlFromPrompt,
    findSqlProblems,
    promptComment,
    validateSqlAnswer,
} from './sql_generation.js';
import { ConnectorType } from '../../connections/connector_info.js';
import { isSystemSchema } from '../../connections/system_schemas.js';
import type { AIClient } from '../../../platform/ai/ai_client.js';
import { Logger } from '../../../platform/logger/logger.js';

class TestLogger extends Logger {
    public destroy(): void { }
    protected flushPendingRecords(): void { }
}

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: core.DashQL;
beforeAll(async () => {
    dql = await core.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});
afterAll(() => dql.resetUnsafe());

describe('SQL generation', () => {
    it('extracts SQL from code fences', () => {
        expect(extractSql('select 1')).toBe('select 1');
        expect(extractSql('  select 1;\n')).toBe('select 1;');
        expect(extractSql('Here you go:\n```sql\nselect 1\nfrom t\n```\nEnjoy')).toBe('select 1\nfrom t');
        expect(extractSql('```\nselect 2\n```')).toBe('select 2');
        expect(() => extractSql('  ')).toThrow('The AI provider returned no SQL');
        expect(() => extractSql('```sql\n```')).toThrow('The AI provider returned no SQL');
    });

    it('comments every line of the question', () => {
        expect(promptComment('how many orders?')).toBe('-- how many orders?');
        expect(promptComment('  first line\r\n\nsecond line\n')).toBe('-- first line\n--\n-- second line');
    });

    it('builds a system prompt with dialect and schema', () => {
        const messages = buildSqlGenerationMessages({
            prompt: 'top customers',
            dialect: describeSqlDialect(ConnectorType.TRINO),
            schema: 'CREATE TABLE "customers" ("id" INTEGER);',
            mentionedIdentifiers: ['customers (table)'],
        });
        expect(messages.map(message => message.role)).toEqual(['system', 'user']);
        expect(messages[0].content).toContain('single SQL query in the Trino dialect');
        expect(messages[0].content).toContain('- no primary keys\n- no indexes\n- no column constraints');
        expect(messages[1].content).toBe([
            'Schema:',
            'CREATE TABLE "customers" ("id" INTEGER);',
            '',
            'Question: top customers',
            'Referenced catalog objects: customers (table)',
        ].join('\n'));
    });

    it('keeps a large schema out of the system message', () => {
        const schema = `CREATE TABLE "wide" (${Array.from({ length: 5000 }, (_, i) => `"column_${i}" INTEGER`).join(', ')});\0`;
        const [system, user] = buildSqlGenerationMessages({ prompt: 'q', dialect: 'Trino', schema, mentionedIdentifiers: [] });
        expect(new TextEncoder().encode(system.content).length).toBeLessThan(16 * 1024);
        expect(user.content).toContain('"column_4999" INTEGER');
        expect(user.content).not.toContain('\0');
    });

    it('describes the user relations of the connection and the session tables', () => {
        const catalog = dql.createCatalog();
        try {
            const scriptSession = dql.createScriptSession(catalog);
            scriptSession.replaceText(scriptSession.getTextVersion(), 'create table summary as select 1 as total, 2 as count');
            scriptSession.analyze();
            scriptSession.loadIntoCatalog(1);
            const relations = [
                '-- DashQL Connection Relations.',
                'CREATE TABLE "db"."public"."orders" ("id" INTEGER, "amount" FLOAT);',
                'CREATE TABLE "db"."pg_catalog"."pg_class" ("oid" INTEGER);',
                'CREATE TABLE "db"."information_schema"."columns" ("table_name" VARCHAR);',
                'CREATE TABLE "db"."pg_toast"."pg_toast_123" ("chunk_id" INTEGER);',
                'CREATE TABLE "db"."sales"."customers" ("id" INTEGER);',
            ].join('\n');
            const conn = { catalogRelationScript: { toString: () => relations } };
            const sessionScripts = { instance: dql, connectionCatalog: catalog, scripts: { 1: { scriptSession } } } as any;
            const logger = new TestLogger();
            expect(buildSchemaContext(conn as any, sessionScripts, logger)).toBe([
                'CREATE TABLE "db"."public"."orders" ("id" INTEGER, "amount" FLOAT);',
                'CREATE TABLE "db"."sales"."customers" ("id" INTEGER);',
                '-- Tables defined by the session, column types are unknown',
                'CREATE TABLE "summary" ("total", "count");',
            ].join('\n'));
            expect(buildSchemaContext(null, sessionScripts, logger)).toBe([
                '-- Tables defined by the session, column types are unknown',
                'CREATE TABLE "summary" ("total", "count");',
            ].join('\n'));
            scriptSession.destroy();
        } finally {
            catalog.destroy();
        }
    });

    it('truncates a large schema at a statement boundary and warns', () => {
        const catalog = dql.createCatalog();
        try {
            const columns = Array.from({ length: 200 }, (_, i) => `"column_${i}" INTEGER`).join(', ');
            const relations = Array.from({ length: 100 }, (_, i) => `CREATE TABLE "public"."t${i}" (${columns});`).join('\n');
            const logger = new TestLogger();
            const warn = vi.spyOn(logger, 'warn');
            const schema = buildSchemaContext(
                { catalogRelationScript: { toString: () => relations } } as any,
                { instance: dql, connectionCatalog: catalog, scripts: {} } as any,
                logger,
            );
            expect(schema.length).toBeLessThan(101_000);
            expect(schema.endsWith(');\n-- The schema is truncated')).toBe(true);
            expect(warn).toHaveBeenCalledOnce();
        } finally {
            catalog.destroy();
        }
    });

    it('recognizes system schemas', () => {
        expect(isSystemSchema('pg_catalog')).toBe(true);
        expect(isSystemSchema('INFORMATION_SCHEMA')).toBe(true);
        expect(isSystemSchema('pg_temp_3')).toBe(true);
        expect(isSystemSchema('public')).toBe(false);
    });

    it('validates answers against the parser and the catalog', () => {
        const catalog = dql.createCatalog();
        try {
            const schema = dql.createScript(catalog);
            schema.replaceText('create table orders (id int, amount int);');
            schema.analyze();
            catalog.loadScript(schema, 0);
            const findProblems = (sql: string) => findSqlProblems(dql, catalog, sql);
            expect(findProblems('select amount from orders')).toEqual([]);
            expect(validateSqlAnswer('```sql\nselect amount from orders\n```', findProblems))
                .toEqual({ valid: true, value: 'select amount from orders' });

            const syntax = validateSqlAnswer('select from from orders', findProblems);
            expect(syntax.valid).toBe(false);
            expect(syntax.value).toBe('select from from orders');
            expect(!syntax.valid && syntax.feedback).toMatch(/^The query is invalid:\n- syntax error/);

            expect(validateSqlAnswer('  ', findProblems)).toEqual({
                valid: false, value: null, feedback: 'The answer contains no SQL. Return only the SQL query.',
            });
            schema.destroy();
        } finally {
            catalog.destroy();
        }
    });

    it('returns the SQL of the last attempt even if it has problems', async () => {
        const completeValidated = vi.fn(async (_messages, validate) => validate('select from from t'));
        const sql = await generateSqlFromPrompt({ completeValidated } as unknown as AIClient, {
            prompt: 'one',
            dialect: 'Trino',
            schema: '',
            mentionedIdentifiers: [],
        }, () => ['syntax error'], new AbortController().signal);
        expect(sql).toBe('select from from t');
    });

    it('fails without any SQL', async () => {
        const completeValidated = vi.fn(async (_messages, validate) => validate(''));
        await expect(generateSqlFromPrompt({ completeValidated } as unknown as AIClient, {
            prompt: 'one',
            dialect: 'Trino',
            schema: '',
            mentionedIdentifiers: [],
        }, () => [], new AbortController().signal)).rejects.toThrow('The AI provider returned no SQL');
    });
});
