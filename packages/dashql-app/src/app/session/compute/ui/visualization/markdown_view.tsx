import * as React from 'react';

import { buffers } from '@ankoh/dashql-core';
import { ArrowTableFormatter } from '../../../../../compute/arrow_formatter.js';
import type { LoggerLike } from '../../../../../platform/logger/logger.js';
import { useLogger } from '../../../../../platform/logger/logger_provider.js';
import { QueryExecutionStatus, type QueryExecutionState } from '../../../../../query/query_execution_state.js';
import * as styles from './markdown_view.module.css';

type MarkdownNode = buffers.visualization.MarkdownNodeT;
type MarkdownSpec = buffers.visualization.MarkdownSpecT;
const NodeType = buffers.visualization.MarkdownNodeType;

export interface MarkdownViewDependencies {
    logger: LoggerLike;
}

interface Props {
    query: QueryExecutionState | null;
    spec: MarkdownSpec | null;
    dependencies?: MarkdownViewDependencies;
}

function renderChildren(node: { children: MarkdownNode[] }, fields: Map<string, string | null>, key: string) {
    return node.children.map((child, index) => renderNode(child, fields, `${key}.${index}`));
}

function renderPlainText(nodes: MarkdownNode[], fields: Map<string, string | null>): string {
    return nodes.map(node => {
        switch (node.nodeType) {
            case NodeType.TEXT:
                return readString(node.value);
            case NodeType.FIELD: {
                const field = readString(node.value);
                return fields.has(field) ? fields.get(field) ?? '' : `{{${field}}}`;
            }
            case NodeType.HARD_BREAK:
                return '\n';
            case NodeType.THEMATIC_BREAK:
                return '';
            default:
                return renderPlainText(node.children, fields);
        }
    }).join('');
}

function readString(value: string | Uint8Array | null): string {
    if (typeof value === 'string') return value;
    return value == null ? '' : new TextDecoder().decode(value);
}

function renderNode(node: MarkdownNode, fields: Map<string, string | null>, key: string): React.ReactNode {
    switch (node.nodeType) {
        case NodeType.DOCUMENT:
        case NodeType.SPAN:
            return <React.Fragment key={key}>{renderChildren(node, fields, key)}</React.Fragment>;
        case NodeType.PARAGRAPH:
            return <p key={key}>{renderChildren(node, fields, key)}</p>;
        case NodeType.BLOCKQUOTE:
            return <blockquote key={key}>{renderChildren(node, fields, key)}</blockquote>;
        case NodeType.LIST_ITEM:
            return <li key={key}>{renderChildren(node, fields, key)}</li>;
        case NodeType.EMPHASIS:
            return <em key={key}>{renderChildren(node, fields, key)}</em>;
        case NodeType.STRONG:
            return <strong key={key}>{renderChildren(node, fields, key)}</strong>;
        case NodeType.HEADING: {
            const Heading = `h${node.level}` as React.ElementType;
            return <Heading key={key}>{renderChildren(node, fields, key)}</Heading>;
        }
        case NodeType.LIST: {
            const children = renderChildren(node, fields, key);
            return node.ordered
                ? <ol key={key} start={node.start}>{children}</ol>
                : <ul key={key}>{children}</ul>;
        }
        case NodeType.TEXT:
            return readString(node.value);
        case NodeType.FIELD: {
            const field = readString(node.value);
            return fields.has(field) ? fields.get(field) : `{{${field}}}`;
        }
        case NodeType.INLINE_CODE:
            return <code key={key}>{renderChildren(node, fields, key)}</code>;
        case NodeType.CODE_BLOCK: {
            const language = readString(node.language);
            return <pre key={key}><code className={language ? `language-${language}` : undefined}>{renderChildren(node, fields, key)}</code></pre>;
        }
        case NodeType.LINK:
            return <a key={key} href={readString(node.url)} title={readString(node.title) || undefined} target="_blank" rel="noopener noreferrer">{renderChildren(node, fields, key)}</a>;
        case NodeType.IMAGE: {
            const alt = renderPlainText(node.children, fields);
            return <img key={key} src={readString(node.url)} title={readString(node.title) || undefined} alt={alt} />;
        }
        case NodeType.HARD_BREAK:
            return <br key={key} />;
        case NodeType.THEMATIC_BREAK:
            return <hr key={key} />;
        case NodeType.NONE:
            return null;
    }
}

export function MarkdownView(props: Props): React.ReactElement {
    const contextLogger = useLogger();
    const logger = props.dependencies?.logger ?? contextLogger;
    const succeeded = props.query?.status === QueryExecutionStatus.SUCCEEDED;
    const table = succeeded ? props.query?.resultTable ?? null : null;

    const renderedRows = React.useMemo(() => {
        if (props.spec == null || table == null) return null;
        const fields = new Map<string, number>();
        table.schema.fields.forEach((field, index) => {
            if (!fields.has(field.name)) fields.set(field.name, index);
        });
        const formatter = new ArrowTableFormatter(table.schema, table.batches, logger);
        const rows: Array<Map<string, string | null>> = [];
        for (let row = 0; row < table.numRows; ++row) {
            const values = new Map<string, string | null>();
            for (const field of props.spec.fields) {
                const column = fields.get(field);
                if (column != null) values.set(field, formatter.getValue(row, column));
            }
            rows.push(values);
        }
        return rows;
    }, [props.spec, table, logger]);

    if (props.spec == null) {
        return <div className={styles.empty}>No visualization available</div>;
    }
    if (!succeeded) {
        return <div className={styles.empty}>Run the query to see the visualization</div>;
    }
    if (renderedRows == null || renderedRows.length === 0) {
        return <div className={styles.empty}>Result is empty</div>;
    }
    const document = props.spec.document;
    if (document == null) {
        return <div className={styles.empty}>No visualization available</div>;
    }

    return (
        <div className={styles.root}>
            {renderedRows.map((fields, row) => (
                <article key={row} className={styles.row} data-markdown-row>
                    {renderNode(document, fields, String(row))}
                </article>
            ))}
        </div>
    );
}
