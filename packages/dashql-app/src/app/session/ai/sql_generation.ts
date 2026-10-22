import * as core from '@ankoh/dashql-core';

import type { AIClient, ChatMessage, CompletionValidation } from '../../../platform/ai/ai_client.js';
import type { Logger } from '../../../platform/logger/logger.js';
import type { AttachedDatabaseState } from '../../connections/attached_database_state.js';
import type { SessionScripts } from '../scripts/session_scripts.js';
import { ConnectorType } from '../../connections/connector_info.js';
import { quoteIdentifier } from '../../connections/catalog_sql_generator.js';
import { isSystemSchema } from '../../connections/system_schemas.js';
import { verifyScript } from '../scripts/scratch_script_verify.js';

const LOG_CTX = 'sql_generation';

/// The schema context is cut off after this many characters to stay within the context window of small models
const SCHEMA_CONTEXT_BUDGET = 100_000;

/// A request to translate a question into SQL
export interface SqlGenerationInput {
    /// The question in natural language
    prompt: string;
    /// The SQL dialect of the connection
    dialect: string;
    /// The schema as CREATE TABLE statements
    schema: string;
    /// The catalog objects that the question mentions, e.g. "orders (table)"
    mentionedIdentifiers: string[];
}

/// Describe the SQL dialect of a connector for the model
export function describeSqlDialect(connectorType: ConnectorType): string {
    switch (connectorType) {
        case ConnectorType.HYPER:
            return 'Tableau Hyper (PostgreSQL-compatible)';
        case ConnectorType.SALESFORCE_DATA_CLOUD:
            return 'Salesforce Data Cloud SQL (PostgreSQL-compatible)';
        case ConnectorType.TRINO:
            return 'Trino';
    }
}

/// The relations of a connection, split by owner
interface ConnectionRelations {
    /// The statements that define relations of user schemas
    statements: string[];
    /// The number of skipped relations of system schemas
    systemRelations: number;
}

/// Pick the statements of the connection relation script that define relations of user schemas.
/// The script is parsed in a scratch catalog, the shared relation script stays untouched.
function describeConnectionRelations(instance: core.DashQL, relationScript: string): ConnectionRelations {
    const relations: ConnectionRelations = { statements: [], systemRelations: 0 };
    const catalog = instance.createCatalog();
    const script = instance.createScript(catalog);
    let parsed: core.FlatBufferPtr<core.buffers.parser.ParsedScript> | null = null;
    try {
        script.replaceText(relationScript);
        script.parse();
        parsed = script.getParsed();
        const reader = parsed.read();
        const statement = new core.buffers.parser.Statement();
        for (let i = 0; i < reader.statementsLength(); ++i) {
            reader.statements(i, statement);
            const schemaName = statement.target()?.schemaName() ?? '';
            if (isSystemSchema(schemaName)) {
                relations.systemRelations += 1;
                continue;
            }
            const span = statement.statementSpan();
            if (span != null) {
                relations.statements.push(`${script.toString(span.offset(), span.length())};`);
            }
        }
    } finally {
        parsed?.destroy();
        script.destroy();
        catalog.destroy();
    }
    return relations;
}

/// Render the tables that the session scripts define as CREATE TABLE statements without types
function describeSessionTables(sessionScripts: SessionScripts): string[] {
    const statements: string[] = [];
    for (const script of Object.values(sessionScripts.scripts)) {
        let entries: core.FlatBufferPtr<core.buffers.catalog.CatalogEntries>;
        try {
            entries = sessionScripts.connectionCatalog.describeEntriesOf(script.scriptSession.getCatalogEntryId());
        } catch {
            // The script is not loaded into the catalog
            continue;
        }
        try {
            const reader = entries.read();
            for (let i = 0; i < reader.entriesLength(); ++i) {
                const entry = reader.entries(i)!;
                for (let j = 0; j < entry.schemasLength(); ++j) {
                    const schema = entry.schemas(j)!;
                    for (let k = 0; k < schema.tablesLength(); ++k) {
                        const table = schema.tables(k)!;
                        const columns: string[] = [];
                        for (let l = 0; l < table.columnsLength(); ++l) {
                            columns.push(quoteIdentifier(table.columns(l)!.columnName() ?? ''));
                        }
                        statements.push(`CREATE TABLE ${quoteIdentifier(table.tableName() ?? '')} (${columns.join(', ')});`);
                    }
                }
            }
        } finally {
            entries.destroy();
        }
    }
    return statements;
}

/// Build the schema that the model may query: the user relations of the connection and the tables of the session.
/// The schema is cut off at a statement boundary once it exceeds the budget.
export function buildSchemaContext(conn: AttachedDatabaseState | null, sessionScripts: SessionScripts, logger: Logger): string {
    const relationScript = conn?.catalogRelationScript.toString() ?? '';
    const relations = relationScript.trim().length > 0
        ? describeConnectionRelations(sessionScripts.instance, relationScript)
        : { statements: [], systemRelations: 0 };
    const sessionTables = describeSessionTables(sessionScripts);

    const statements = [...relations.statements];
    if (sessionTables.length > 0) {
        statements.push('-- Tables defined by the session, column types are unknown', ...sessionTables);
    }
    let schema = '';
    let included = 0;
    for (const statement of statements) {
        if (schema.length + statement.length + 1 > SCHEMA_CONTEXT_BUDGET) {
            break;
        }
        schema += schema.length > 0 ? `\n${statement}` : statement;
        ++included;
    }
    const truncated = included < statements.length;
    if (truncated) {
        schema += '\n-- The schema is truncated';
        logger.warn('Truncated the schema for SQL generation', {
            budget: String(SCHEMA_CONTEXT_BUDGET),
            included: String(included),
            total: String(statements.length),
        }, LOG_CTX);
    }
    logger.debug('Built the schema for SQL generation', {
        connectionRelations: String(relations.statements.length),
        skippedSystemRelations: String(relations.systemRelations),
        sessionTables: String(sessionTables.length),
        characters: String(schema.length),
        truncated: String(truncated),
    }, LOG_CTX);
    return schema;
}

/// Build the messages of a one-shot translation into SQL.
///
/// The system message only holds the fixed instructions: providers limit its size (e.g. to 16 KiB),
/// the schema can be much larger and goes into the user message.
export function buildSqlGenerationMessages(input: SqlGenerationInput): ChatMessage[] {
    const system = [
        `You translate questions about data into a single SQL query in the ${input.dialect} dialect.`,
        'Return only the SQL query: no explanation, no comments, no markdown code fences.',
        'Use only the tables and columns of the schema that the user provides and quote identifiers where needed.',
        'Prefer read-only queries.',
        'When you create a table, declare only column names and types:',
        '- no primary keys',
        '- no indexes',
        '- no column constraints such as NOT NULL, UNIQUE, CHECK, DEFAULT or REFERENCES',
    ].join('\n');
    const user = [
        'Schema:',
        input.schema.length > 0 ? input.schema : '-- The schema is empty',
        '',
        `Question: ${input.prompt}`,
    ];
    if (input.mentionedIdentifiers.length > 0) {
        user.push(`Referenced catalog objects: ${input.mentionedIdentifiers.join(', ')}`);
    }
    return [
        { role: 'system', content: system },
        // Providers reject NUL characters
        { role: 'user', content: user.join('\n').replace(/\0/g, '') },
    ];
}

/// Extract the SQL from the answer of a model, models tend to wrap it in a markdown code fence anyway
export function extractSql(content: string): string {
    const fence = /```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/.exec(content);
    const sql = (fence != null ? fence[1] : content).trim();
    if (sql.length === 0) {
        throw new Error('The AI provider returned no SQL');
    }
    return sql;
}

/// Render a question as line comments, the preamble of the generated script.
/// Every line is commented on its own, the question cannot escape the comment.
export function promptComment(prompt: string): string {
    return prompt.trim().split(/\r?\n/).map(line => `-- ${line}`.trimEnd()).join('\n');
}

/// Find the problems of a SQL query: parser errors and analyzer errors against the catalog, e.g. unknown tables
export function findSqlProblems(instance: core.DashQL, catalog: core.DashQLCatalog, sql: string): string[] {
    const result = verifyScript(instance, catalog, sql);
    return [...result.parserErrors, ...result.analyzerErrors];
}

/// Validate an answer of the model: it must contain SQL without problems
export function validateSqlAnswer(content: string, findProblems: (sql: string) => string[]): CompletionValidation<string> {
    let sql: string;
    try {
        sql = extractSql(content);
    } catch {
        return { valid: false, value: null, feedback: 'The answer contains no SQL. Return only the SQL query.' };
    }
    const problems = findProblems(sql);
    if (problems.length === 0) {
        return { valid: true, value: sql };
    }
    return {
        valid: false,
        value: sql,
        feedback: `The query is invalid:\n${problems.map(problem => `- ${problem}`).join('\n')}\nReturn only the corrected SQL query.`,
    };
}

/// Translate a question into a SQL query.
/// A query with problems goes back to the model once. If the retry has problems as well, the query is returned anyway,
/// the user sees the problems in the editor and can fix them. Only an answer without any SQL fails.
export async function generateSqlFromPrompt(
    client: AIClient,
    input: SqlGenerationInput,
    findProblems: (sql: string) => string[],
    signal: AbortSignal,
): Promise<string> {
    const verdict = await client.completeValidated(
        buildSqlGenerationMessages(input),
        content => validateSqlAnswer(content, findProblems),
        signal,
    );
    if (verdict.value == null) {
        throw new Error('The AI provider returned no SQL');
    }
    return verdict.value;
}
