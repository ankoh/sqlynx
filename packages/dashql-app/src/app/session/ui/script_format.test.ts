import * as dashql from '@ankoh/dashql-core';

import { beforeAll, describe, expect, it } from 'vitest';

import { ConnectorType } from '../../connections/connector_info.js';
import { createScriptFormatConfig, formatScriptEditor, formattingDialectForConnector, isScriptFormattable, measureScriptFormatWidth } from './script_format.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

let dql: dashql.DashQL;
beforeAll(async () => {
    dql = await dashql.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED });
});

describe('script formatting', () => {
    it('uses the shared configuration for compact formatting', () => {
        const config = createScriptFormatConfig(
            dashql.buffers.formatting.FormattingMode.COMPACT,
            false,
            80,
        );

        expect(config.maxWidth).toBe(80);
        expect(config.indentationWidth).toBe(4);
    });

    it('selects Trino only for the Trino connector', () => {
        const dialects = dashql.buffers.formatting.FormattingDialect;
        expect(formattingDialectForConnector(ConnectorType.TRINO)).toBe(dialects.TRINO);
        expect(formattingDialectForConnector(ConnectorType.HYPER)).toBe(dialects.HYPER);
        expect(formattingDialectForConnector(ConnectorType.SALESFORCE_DATA_CLOUD)).toBe(dialects.HYPER);
        expect(formattingDialectForConnector()).toBe(dialects.HYPER);
    });

    it('passes the chosen dialect to formatability and editor formatting', () => {
        const dialect = formattingDialectForConnector(ConnectorType.TRINO);
        const isFullyFormattable = vi.fn((_config: dashql.buffers.formatting.FormattingConfigT) => true);
        expect(isScriptFormattable({ scriptSession: { isFullyFormattable } } as any, dialect)).toBe(true);
        expect(isFullyFormattable.mock.calls[0][0].dialect).toBe(dialect);

        const format = vi.fn((_config: dashql.buffers.formatting.FormattingConfigT) =>
            ({ toString: () => 'select 1;', destroy: vi.fn() }));
        const onFormattedText = vi.fn();
        const editorView = {
            state: { doc: { toString: () => 'select 1' } },
            defaultCharacterWidth: 8,
            scrollDOM: { clientWidth: 640 },
            focus: vi.fn(),
        } as any;
        expect(formatScriptEditor(editorView, { scriptSession: { format } } as any,
            dashql.buffers.formatting.FormattingMode.PRETTY, onFormattedText, false,
            dashql.buffers.formatting.KeywordCase.LOWER, dialect)).toBe(true);
        expect(format.mock.calls[0][0].dialect).toBe(dialect);
    });

    it('measures the formatter width from the writable editor viewport', () => {
        expect(measureScriptFormatWidth({
            defaultCharacterWidth: 8,
            scrollDOM: { clientWidth: 600 },
        } as any)).toBe(75);
        expect(measureScriptFormatWidth({
            defaultCharacterWidth: 8,
            scrollDOM: { clientWidth: 120 },
        } as any)).toBe(24);
    });

    it('keeps compact output distinct from pretty output', () => {
        const catalog = dql.createCatalog();
        const session = dql.createScriptSession(catalog);
        let compact: dashql.DashQLScript | null = null;
        let pretty: dashql.DashQLScript | null = null;
        try {
            session.replaceText(0n, 'select count(*) from items where value > 1');
            compact = session.format(createScriptFormatConfig(
                dashql.buffers.formatting.FormattingMode.COMPACT,
            ));
            pretty = session.format(createScriptFormatConfig(
                dashql.buffers.formatting.FormattingMode.PRETTY,
            ));

            expect(compact.toString()).toBe('select count(*) from items where value > 1;');
            expect(pretty.toString()).toBe('select count(*)\nfrom items\nwhere value > 1;');
        } finally {
            compact?.destroy();
            pretty?.destroy();
            session.destroy();
            catalog.destroy();
        }
    });

    it('pretty formats array types in the connector dialect', () => {
        const catalog = dql.createCatalog();
        const session = dql.createScriptSession(catalog);
        const input = 'select cast(payload as array(json)) from events';
        try {
            session.replaceText(0n, input);
            const editorView = {
                state: { doc: { toString: () => input } },
                defaultCharacterWidth: 8,
                scrollDOM: { clientWidth: 640 },
                focus: vi.fn(),
            } as any;
            for (const [connector, arrayType] of [
                [ConnectorType.TRINO, 'array(json)'],
                [ConnectorType.HYPER, 'json[]'],
                [ConnectorType.SALESFORCE_DATA_CLOUD, 'json[]'],
            ] as const) {
                const dialect = formattingDialectForConnector(connector);
                const onFormattedText = vi.fn();
                expect(isScriptFormattable({ scriptSession: session } as any, dialect)).toBe(true);
                expect(formatScriptEditor(editorView, { scriptSession: session } as any,
                    dashql.buffers.formatting.FormattingMode.PRETTY, onFormattedText, false,
                    dashql.buffers.formatting.KeywordCase.LOWER, dialect)).toBe(true);
                expect(onFormattedText).toHaveBeenCalledWith(`select cast(payload as ${arrayType})\nfrom events;`);
            }
        } finally {
            session.destroy();
            catalog.destroy();
        }
    });

    it('uses uppercase keywords in both layout modes', () => {
        const catalog = dql.createCatalog();
        const session = dql.createScriptSession(catalog);
        try {
            session.replaceText(0n, 'select count(*) from items where value > 1');
            for (const mode of [dashql.buffers.formatting.FormattingMode.COMPACT, dashql.buffers.formatting.FormattingMode.PRETTY]) {
                const result = session.format(createScriptFormatConfig(mode, false, 80, dashql.buffers.formatting.KeywordCase.UPPER));
                expect(result.toString()).toContain('SELECT count(*)');
                expect(result.toString()).toContain('FROM items');
                result.destroy();
            }
        } finally {
            session.destroy();
            catalog.destroy();
        }
    });

    it('applies pretty formatting as an edit to the writable editor', () => {
        const catalog = dql.createCatalog();
        const session = dql.createScriptSession(catalog);
        const onFormattedText = vi.fn();
        const focus = vi.fn();
        try {
            session.replaceText(0n, 'select count(*) from items where value > 1');
            const text = session.getText();
            const editorView = {
                state: { doc: { length: text.length, toString: () => text } },
                defaultCharacterWidth: 8,
                scrollDOM: { clientWidth: 320 },
                focus,
            } as any;

            expect(formatScriptEditor(editorView, { scriptSession: session } as any,
                dashql.buffers.formatting.FormattingMode.PRETTY, onFormattedText)).toBe(true);
            expect(onFormattedText).toHaveBeenCalledWith('select count(*)\nfrom items\nwhere value > 1;');
            expect(focus).toHaveBeenCalledOnce();
        } finally {
            session.destroy();
            catalog.destroy();
        }
    });

    it('passes the current editor width to the formatter', () => {
        const onFormattedText = vi.fn();
        const focus = vi.fn();
        const destroy = vi.fn();
        const format = vi.fn((config: dashql.buffers.formatting.FormattingConfigT) => {
            expect(config.maxWidth).toBe(75);
            return { toString: () => 'select 1;', destroy };
        });
        const editorView = {
            state: { doc: { length: 8, toString: () => 'select 1' } },
            defaultCharacterWidth: 8,
            scrollDOM: { clientWidth: 600 },
            focus,
        } as any;

        expect(formatScriptEditor(editorView, { scriptSession: { format } } as any,
            dashql.buffers.formatting.FormattingMode.PRETTY, onFormattedText)).toBe(true);
        expect(format).toHaveBeenCalledOnce();
        expect(onFormattedText).toHaveBeenCalledWith('select 1;');
        expect(destroy).toHaveBeenCalledOnce();
    });

});
