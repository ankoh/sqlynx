import { buffers } from '@ankoh/dashql-core';
import type { AnalyzedSql } from './core.js';
import { Ast, AttributeKey as K, NodeType as T } from './ast.js';
import { describeVisualization } from './visualization.js';

/// Structural features of a SQL script, extracted from the DashQL AST and analyzer output
export interface SyntaxFeatures {
    /// One entry per statement, e.g. "select" or "create table"
    statementTypes: string[];
    tables: string[];
    columns: string[];
    /// Names of the functions that are called, e.g. `date_trunc`
    functions: string[];
    aggregates: string[];
    /// The function calls with their arguments, e.g. `date_trunc('day', orders.o_orderdate)`. Literal arguments are kept.
    functionCalls: string[];
    ctes: string[];
    joins: string[];
    filters: string[];
    operators: string[];
    /// Names of the result columns of the (first) top-level select
    outputColumns: string[];
    groupBy: string[];
    orderBy: string[];
    /// What the trailing VISUALIZE statement renders, one entry per chart, e.g. `vegalite scatter plot (point, x Year temporal)`
    visualizations: string[];
}

const AGGREGATES = new Set([
    'sum', 'count', 'avg', 'min', 'max', 'median', 'mode', 'stddev', 'stddev_pop', 'stddev_samp', 'variance',
    'var_pop', 'var_samp', 'string_agg', 'array_agg', 'bool_and', 'bool_or', 'every', 'any_value',
    'approx_count_distinct', 'percentile_cont', 'percentile_disc', 'corr', 'covar_pop', 'covar_samp', 'first',
    'last', 'listagg',
]);

const OPERATOR_SYMBOLS: Record<string, string> = {
    EQUAL: '=',
    NOT_EQUAL: '<>',
    LESS_THAN: '<',
    LESS_EQUAL: '<=',
    GREATER_THAN: '>',
    GREATER_EQUAL: '>=',
    LIKE: 'like',
    NOT_LIKE: 'not like',
    ILIKE: 'ilike',
    NOT_ILIKE: 'not ilike',
    SIMILAR_TO: 'similar to',
    NOT_SIMILAR_TO: 'not similar to',
    IN: 'in',
    NOT_IN: 'not in',
    IS_NULL: 'is null',
    NOT_NULL: 'is not null',
    IS_TRUE: 'is true',
    IS_FALSE: 'is false',
    IS_DISTINCT_FROM: 'is distinct from',
    IS_NOT_DISTINCT_FROM: 'is not distinct from',
    BETWEEN_SYMMETRIC: 'between',
    BETWEEN_ASYMMETRIC: 'between',
    NOT_BETWEEN_SYMMETRIC: 'not between',
    NOT_BETWEEN_ASYMMETRIC: 'not between',
};

/// Operators that keep their meaning when the operands are swapped (or flip to a known counterpart)
const FLIPPED: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '<>': '<>' };

/// Canonical order of the operator list
const OPERATOR_ORDER = [
    'cte', 'subquery', 'exists', 'case', 'window', 'distinct', 'group by', 'having', 'order by', 'limit',
    'union', 'union all', 'intersect', 'intersect all', 'except', 'except all',
];

function operatorRank(operator: string): number {
    const i = OPERATOR_ORDER.indexOf(operator);
    // Join types come first, in alphabetical order among themselves
    return i >= 0 ? i + 1 : operator.endsWith(' join') ? 0 : OPERATOR_ORDER.length + 1;
}

/// Symbols of all operators that are rendered in expressions
const EXPRESSION_SYMBOLS: Record<string, string> = {
    ...OPERATOR_SYMBOLS,
    PLUS: '+',
    MINUS: '-',
    NEGATE: '-',
    MULTIPLY: '*',
    DIVIDE: '/',
    MODULUS: '%',
    AND: 'and',
    OR: 'or',
    XOR: 'xor',
    NOT: 'not',
    GLOB: 'glob',
    NOT_GLOB: 'not glob',
};

const POSTFIX_OPERATORS = new Set(['IS_NULL', 'NOT_NULL', 'IS_TRUE', 'IS_FALSE', 'IS_UNKNOWN', 'IS_NOT_TRUE', 'IS_NOT_FALSE', 'IS_NOT_UNKNOWN']);

const MAX_LABEL_LENGTH = 60;
const MAX_EXPRESSION_LENGTH = 120;

/// Collapse whitespace and lowercase everything except string literals
function normalizeText(text: string): string {
    return text
        .split(/('(?:[^']|'')*')/)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s+/g, ' ').toLowerCase()))
        .join('')
        .trim();
}

/// Binding strength of expression operators, used to place parentheses
function precedence(op: string): number {
    switch (op) {
        case 'NEGATE': return 7;
        case 'MULTIPLY': case 'DIVIDE': case 'MODULUS': return 6;
        case 'PLUS': case 'MINUS': return 5;
        case 'NOT': return 3;
        case 'AND': return 2;
        case 'OR': case 'XOR': return 1;
        default: return 4; // comparisons, LIKE, IN, BETWEEN, IS ...
    }
}

function limitLength(text: string): string {
    return text.length > MAX_EXPRESSION_LENGTH ? `${text.slice(0, MAX_EXPRESSION_LENGTH - 3)}...` : text;
}

function words(name: string): string {
    return name.toLowerCase().replace(/_/g, ' ');
}

/// "OUTER_LEFT" -> "left outer", "NATURAL_INNER" -> "natural inner"
function joinTypeName(value: number): string {
    const parts = (buffers.parser.JoinType[value] ?? 'INNER').toLowerCase().split('_').filter(p => p.length > 0);
    if (parts[0] === 'outer' && parts.length > 1) return `${parts[1]} outer`;
    if (parts[0] === 'natural' && parts[1] === 'outer' && parts.length > 2) return `natural ${parts[2]} outer`;
    return parts.join(' ');
}

function qualified(name: buffers.analyzer.QualifiedTableName | null): string {
    if (!name) return '';
    return [name.databaseName(), name.schemaName(), name.tableName()].filter(s => !!s).join('.');
}

function uniqueSorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort();
}

function collapse(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_LABEL_LENGTH ? `${flat.slice(0, MAX_LABEL_LENGTH - 3)}...` : flat;
}

interface ColumnInfo {
    table: string | null;
    label: string;
}

export function extractSyntaxFeatures(sql: AnalyzedSql): SyntaxFeatures | null {
    if (!sql.parsed || !sql.analyzed) {
        return null;
    }
    const parsed = sql.parsed;
    const analyzed = sql.analyzed;
    const ast = new Ast(parsed, sql.bytes);

    // Statements
    const statementTypes: string[] = [];
    const statementRoots = new Set<number>();
    for (let i = 0; i < parsed.statementsLength(); ++i) {
        const statement = parsed.statements(i)!;
        // A VISUALIZE statement wraps a select, name it by what it does ("vis visualise" is the grammar's name)
        statementTypes.push(
            statement.statementType() === buffers.parser.StatementType.VIS_VISUALISE
                ? 'visualize'
                : words(buffers.parser.StatementType[statement.statementType()] ?? 'none'),
        );
        statementRoots.add(statement.rootNode());
    }

    // CTE names
    const ctes = new Set<string>();
    for (let i = 0; i < ast.length; ++i) {
        if (ast.type(i) === T.OBJECT_SQL_CTE) {
            const name = ast.child(i, K.SQL_CTE_NAME);
            if (name !== null) ctes.add(ast.nameText(name));
        }
    }

    // Tables
    const tableById = new Map<string, string>();
    const definedHere = new Set<string>();
    for (let i = 0; i < analyzed.tablesLength(); ++i) {
        const table = analyzed.tables(i)!;
        const name = qualified(table.tableName());
        tableById.set(table.catalogTableId().toString(), name);
        definedHere.add(name);
    }
    // Tables defined by the script itself (CREATE TABLE ...) count as tables of the script
    const tables = new Set<string>([...definedHere].filter(name => name.length > 0));
    const aliases = new Map<string, string>();
    for (let i = 0; i < analyzed.tableReferencesLength(); ++i) {
        const ref = analyzed.tableReferences(i)!;
        const resolved = ref.resolvedTable();
        let name: string;
        if (resolved) {
            name = qualified(resolved.tableName());
            tableById.set(resolved.catalogTableId().toString(), name);
        } else {
            name = qualified(ref.tableName());
            if (ctes.has(name)) {
                // CTE references are tracked separately
                const alias = ref.aliasName();
                if (alias) aliases.set(alias.toLowerCase(), name);
                continue;
            }
        }
        if (name) tables.add(name);
        const alias = ref.aliasName();
        if (alias) aliases.set(alias.toLowerCase(), name);
    }

    // Output columns of the first top-level select
    const outputColumns: string[] = [];
    const outputAliases = new Set<string>();
    const targetsOf = (select: number): number | null => {
        const direct = ast.child(select, K.SQL_SELECT_TARGETS);
        if (direct !== null) return direct;
        const inputs = ast.child(select, K.SQL_COMBINE_INPUT);
        const first = inputs !== null ? ast.children(inputs)[0] : undefined;
        return first !== undefined ? targetsOf(first) : null;
    };
    for (const statementRoot of statementRoots) {
        // The query of a VISUALIZE statement is its select, its output columns are the ones of the script
        const root = ast.type(statementRoot) === T.OBJECT_VIS_VISUALISE
            ? (ast.child(statementRoot, K.VIS_VISUALISE_SELECT) ?? statementRoot)
            : statementRoot;
        if (ast.type(root) !== T.OBJECT_SQL_SELECT || outputColumns.length > 0) continue;
        const targets = targetsOf(root);
        if (targets === null) continue;
        for (const target of ast.children(targets)) {
            const alias = ast.child(target, K.SQL_RESULT_TARGET_NAME);
            const value = ast.child(target, K.SQL_RESULT_TARGET_VALUE);
            if (alias !== null) {
                const name = ast.nameText(alias);
                outputAliases.add(name);
                outputColumns.push(name);
            } else if (ast.child(target, K.SQL_RESULT_TARGET_STAR) !== null) {
                outputColumns.push('*');
            } else if (value !== null) {
                outputColumns.push(collapse(ast.text(value)).toLowerCase());
            }
        }
    }

    const inVisualizeSpec = (node: number): boolean => {
        for (let p: number | null = node; p !== null; p = ast.parent(p)) {
            if (ast.key(p) === K.VIS_VISUALISE_SPEC) return true;
        }
        return false;
    };

    // Column references by AST node id
    const columnByNode = new Map<number, ColumnInfo>();
    const columns = new Set<string>();
    const colRef = new buffers.algebra.ColumnRefExpression();
    for (let i = 0; i < analyzed.expressionsLength(); ++i) {
        const expr = analyzed.expressions(i)!;
        if (expr.innerType() !== buffers.algebra.ExpressionSubType.ColumnRefExpression) continue;
        expr.inner(colRef);
        const name = colRef.columnName();
        const column = (name?.columnName() ?? '').toLowerCase();
        const resolved = colRef.resolvedColumn();
        let table: string | null = null;
        if (resolved) {
            table = tableById.get(resolved.catalogTableId().toString()) ?? null;
        } else if (name?.tableAlias()) {
            const alias = name.tableAlias()!.toLowerCase();
            table = aliases.get(alias) ?? alias;
        }
        const label = table ? `${table}.${column}` : column;
        columnByNode.set(expr.astNodeId(), { table, label });
        // Fields of the VISUALIZE spec name result columns of the query (often aliases like `total`), so they are not
        // columns of the script. They show up in the visualization description instead.
        if (!inVisualizeSpec(expr.astNodeId()) && (resolved || table || !outputAliases.has(column))) {
            columns.add(label);
        }
    }

    const functionName = (node: number): string => {
        const name = ast.child(node, K.SQL_FUNCTION_NAME);
        if (name === null) return 'unknown';
        if (ast.type(name) === T.ENUM_SQL_KNOWN_FUNCTION) {
            return (buffers.parser.KnownFunction[ast.value(name)] ?? 'unknown').toLowerCase();
        }
        return ast.nameText(name);
    };
    // Expressions are rendered as written: literals and function names are kept, columns are qualified
    // and spacing and case are normalized. `date_trunc('day', ts) > current_timestamp - interval '30' day` stays that.
    const operatorOf = (node: number): string | null => {
        const op = ast.child(node, K.SQL_EXPRESSION_OPERATOR);
        return op !== null ? (buffers.parser.ExpressionOperator[ast.value(op)] ?? null) : null;
    };
    const argsOf = (node: number): number[] => {
        const args = ast.child(node, K.SQL_EXPRESSION_ARGS);
        return args !== null ? ast.children(args) : [];
    };
    const render = (node: number): string => {
        const column = columnByNode.get(node);
        if (column) return column.label;
        switch (ast.type(node)) {
            case T.LITERAL_INTEGER:
            case T.LITERAL_FLOAT:
            case T.LITERAL_STRING:
            case T.LITERAL_NULL:
            case T.LITERAL_INTERVAL:
                return normalizeText(ast.text(node));
            case T.BOOL:
                return ast.value(node) ? 'true' : 'false';
            case T.OBJECT_SQL_FUNCTION_EXPRESSION:
                return renderCall(node);
            case T.OBJECT_SQL_NARY_EXPRESSION:
                return renderNary(node);
            case T.OBJECT_SQL_CONST_INTERVAL_CAST: {
                const value = ast.child(node, K.SQL_CONST_CAST_VALUE);
                const unit = ast.child(node, K.SQL_CONST_CAST_INTERVAL);
                const unitType = unit !== null ? ast.child(unit, K.SQL_INTERVAL_TYPE) : null;
                const unitName = unitType !== null ? words(buffers.parser.IntervalType[ast.value(unitType)] ?? '') : '';
                return ['interval', value !== null ? normalizeText(ast.text(value)) : '', unitName].filter(p => p).join(' ');
            }
            case T.OBJECT_SQL_CONST_FUNCTION_CAST: {
                const name = ast.child(node, K.SQL_CONST_CAST_FUNC_NAME);
                const value = ast.child(node, K.SQL_CONST_CAST_VALUE);
                return [name !== null ? ast.nameText(name) : '', value !== null ? normalizeText(ast.text(value)) : ''].filter(p => p).join(' ');
            }
            case T.OBJECT_SQL_SUBQUERY_EXPRESSION:
            case T.OBJECT_SQL_SELECT:
                return '<subquery>';
            case T.ARRAY:
                return `(${ast.children(node).map(render).join(', ')})`;
        }
        return normalizeText(ast.text(node));
    };
    const renderCall = (fn: number): string => {
        const name = functionName(fn);
        const star = ast.child(fn, K.SQL_FUNCTION_ARGUMENTS_STAR) !== null;
        const extract = ast.child(fn, K.SQL_FUNCTION_EXTRACT_ARGS);
        const args = ast.child(fn, K.SQL_FUNCTION_ARGUMENTS);
        const distinct = ast.child(fn, K.SQL_FUNCTION_DISTINCT) !== null ? 'distinct ' : '';
        let body: string | null = null;
        if (star) {
            body = '*';
        } else if (extract !== null) {
            const target = ast.child(extract, K.SQL_FUNCTION_EXTRACT_TARGET);
            const input = ast.child(extract, K.SQL_FUNCTION_EXTRACT_INPUT);
            const targetName = target !== null ? (buffers.parser.ExtractTarget[ast.value(target)] ?? '').toLowerCase() : '';
            body = input !== null ? `${targetName} from ${render(input)}` : targetName;
        } else if (args !== null) {
            body = ast
                .children(args)
                .map(arg => {
                    if (ast.type(arg) !== T.OBJECT_SQL_FUNCTION_ARG) return render(arg);
                    const value = ast.child(arg, K.SQL_FUNCTION_ARG_VALUE);
                    const argName = ast.child(arg, K.SQL_FUNCTION_ARG_NAME);
                    const rendered = value !== null ? render(value) : normalizeText(ast.text(arg));
                    return argName !== null ? `${ast.nameText(argName)} => ${rendered}` : rendered;
                })
                .join(', ');
        } else if (
            ast.children(fn).some(c => ![K.SQL_FUNCTION_NAME, K.SQL_FUNCTION_OVER, K.SQL_FUNCTION_DISTINCT, K.SQL_FUNCTION_FILTER, K.SQL_FUNCTION_ORDER, K.SQL_FUNCTION_ALL].includes(ast.key(c)))
        ) {
            // Special argument syntax (CAST, TRIM, SUBSTRING, ...)
            return normalizeText(ast.text(fn));
        }
        const known = (() => {
            const n = ast.child(fn, K.SQL_FUNCTION_NAME);
            return n !== null && ast.type(n) === T.ENUM_SQL_KNOWN_FUNCTION;
        })();
        // `current_timestamp` is written without parentheses, `now()` with
        let call = body === null && known ? name : `${name}(${distinct}${body ?? ''})`;
        const over = ast.child(fn, K.SQL_FUNCTION_OVER);
        if (over !== null) call += ` over ${normalizeText(ast.text(over))}`;
        return call;
    };
    const renderNary = (node: number): string => {
        const op = operatorOf(node);
        const args = argsOf(node);
        if (op === null || args.length === 0 || op === 'TYPECAST') return normalizeText(ast.text(node));
        const symbol = EXPRESSION_SYMBOLS[op] ?? words(op);
        // Parentheses only where the nesting needs them: 1 - (a - b), x * (a + b), but not x > a - b
        const operand = (a: number, i = 0) => {
            if (ast.type(a) !== T.OBJECT_SQL_NARY_EXPRESSION) return render(a);
            const childOp = operatorOf(a);
            const needsParens = childOp === null || precedence(childOp) < precedence(op) || (precedence(childOp) === precedence(op) && i > 0);
            return needsParens ? `(${render(a)})` : render(a);
        };
        if (args.length === 1) {
            return POSTFIX_OPERATORS.has(op) ? `${operand(args[0])} ${symbol}` : `${symbol}${symbol === 'not' ? ' ' : ''}${operand(args[0])}`;
        }
        if (op.includes('BETWEEN') && args.length === 3) {
            return `${operand(args[0])} ${symbol} ${operand(args[1])} and ${operand(args[2])}`;
        }
        return args.map((a, i) => operand(a, i)).join(` ${symbol} `);
    };
    const renderExpr = (node: number): string => limitLength(render(node));
    // `group by 1` and `order by 1` refer to the select list, show what they stand for
    const expressionLabel = (node: number): string => {
        if (ast.type(node) === T.LITERAL_INTEGER) {
            let select = ast.parent(node);
            while (select !== null && ast.type(select) !== T.OBJECT_SQL_SELECT) select = ast.parent(select);
            const targets = select !== null ? ast.child(select, K.SQL_SELECT_TARGETS) : null;
            const target = targets !== null ? ast.children(targets)[Number(ast.text(node)) - 1] : undefined;
            const value = target !== undefined ? ast.child(target, K.SQL_RESULT_TARGET_VALUE) : null;
            if (value !== null) return renderExpr(value);
        }
        return renderExpr(node);
    };

    const containsColumn = (node: number): boolean => {
        let found = false;
        ast.walk(node, n => {
            if (columnByNode.has(n)) found = true;
            return !found;
        });
        return found;
    };

    // Filters and join edges
    const joins = new Set<string>();
    const filters = new Set<string>();
    const predicate = (node: number, allowJoin: boolean): void => {
        if (ast.type(node) !== T.OBJECT_SQL_NARY_EXPRESSION) return;
        const op = operatorOf(node);
        const args = argsOf(node);
        if (op === 'AND') {
            args.forEach(a => predicate(a, allowJoin));
            return;
        }
        if (op === 'OR' || op === 'NOT') {
            args.forEach(a => predicate(a, false));
            return;
        }
        const symbol = op !== null ? OPERATOR_SYMBOLS[op] : undefined;
        if (!symbol || args.length === 0) return;
        const left = columnByNode.get(args[0]);
        const right = args.length > 1 ? columnByNode.get(args[1]) : undefined;
        if (left && right && symbol === '=' && allowJoin && args.length === 2) {
            if (left.table && right.table && left.table !== right.table) {
                joins.add([left.label, right.label].sort().join(' = '));
                return;
            }
        }
        if (!containsColumn(node)) return;
        if (args.length === 2 && !columnByNode.has(args[0]) && right && FLIPPED[symbol]) {
            // Canonicalize <value> <op> <column> to <column> <flipped op> <value>
            filters.add(limitLength(`${render(args[1])} ${FLIPPED[symbol]} ${render(args[0])}`));
            return;
        }
        filters.add(limitLength(renderNary(node)));
    };

    // Single pass over the flat node array
    const operators = new Set<string>();
    const functions = new Set<string>();
    const aggregates = new Set<string>();
    const calls = new Set<string>();
    const groupBy = new Set<string>();
    const orderBy = new Set<string>();
    const slotKey = (node: number): buffers.parser.AttributeKey => {
        const key = ast.key(node);
        if (key !== K.NONE) return key;
        const parent = ast.parent(node);
        return parent !== null && ast.type(parent) === T.ARRAY ? ast.key(parent) : K.NONE;
    };
    for (let i = 0; i < ast.length; ++i) {
        const type = ast.type(i);
        const key = ast.key(i);
        switch (key) {
            case K.SQL_SELECT_WHERE:
                predicate(i, true);
                break;
            case K.SQL_SELECT_HAVING:
                operators.add('having');
                predicate(i, false);
                break;
            case K.SQL_JOIN_ON:
                predicate(i, true);
                break;
            case K.SQL_JOIN_USING: {
                // Columns joined by name: tables come from the two join inputs
                const parent = ast.parent(i);
                const inputs = parent !== null ? ast.child(parent, K.SQL_JOIN_INPUT) : null;
                const names = ast.children(i).map(c => ast.nameText(c));
                if (inputs !== null) {
                    const sides = ast.children(inputs).map(input => {
                        let found = '';
                        ast.walk(input, n => {
                            if (found === '' && ast.key(n) === K.SQL_TABLEREF_NAME) {
                                found = ast.nameText(n);
                                const resolved = aliases.get(found.toLowerCase());
                                found = resolved ?? found;
                            }
                        });
                        return found;
                    });
                    if (sides.length === 2 && sides[0] && sides[1]) {
                        joins.add(`${[sides[0], sides[1]].sort().join(' = ')} using (${names.join(', ')})`);
                    }
                }
                break;
            }
            case K.SQL_JOIN_TYPE: {
                const name = joinTypeName(ast.value(i));
                operators.add(name === 'none' ? 'join' : `${name} join`);
                break;
            }
            case K.SQL_SELECT_GROUPS:
                operators.add('group by');
                for (const item of ast.children(i)) {
                    const arg = ast.child(item, K.SQL_GROUP_BY_ITEM_ARG);
                    if (arg !== null) groupBy.add(expressionLabel(arg));
                }
                break;
            case K.SQL_SELECT_ORDER:
                operators.add('order by');
                for (const item of ast.children(i)) {
                    const value = ast.child(item, K.SQL_ORDER_VALUE);
                    if (value !== null) orderBy.add(expressionLabel(value));
                }
                break;
            case K.SQL_SELECT_LIMIT:
                operators.add('limit');
                break;
            case K.SQL_SELECT_DISTINCT:
                if (type !== T.BOOL || ast.value(i)) operators.add('distinct');
                break;
            case K.SQL_SELECT_WITH_CTES:
                operators.add('cte');
                break;
            case K.SQL_FUNCTION_OVER:
                operators.add('window');
                break;
            case K.SQL_COMBINE_OPERATION: {
                const op = words(buffers.parser.CombineOperation[ast.value(i)] ?? 'union');
                const parent = ast.parent(i);
                const modifier = parent !== null ? ast.child(parent, K.SQL_COMBINE_MODIFIER) : null;
                const all = modifier !== null && ast.value(modifier) === buffers.parser.CombineModifier.ALL;
                operators.add(all ? `${op} all` : op);
                break;
            }
        }
        switch (type) {
            case T.OBJECT_SQL_FUNCTION_EXPRESSION: {
                const name = functionName(i);
                if (AGGREGATES.has(name)) aggregates.add(name);
                else functions.add(name);
                calls.add(renderExpr(i));
                break;
            }
            case T.OBJECT_SQL_CASE:
                operators.add('case');
                break;
            case T.OBJECT_SQL_EXISTS_EXPRESSION:
                operators.add('exists');
                break;
            case T.OBJECT_SQL_SUBQUERY_EXPRESSION:
                operators.add('subquery');
                break;
            case T.OBJECT_SQL_SELECT: {
                if (statementRoots.has(i)) break;
                const slot = slotKey(i);
                if (slot === K.SQL_CTE_STATEMENT || slot === K.SQL_COMBINE_INPUT) break;
                // Only selects nested in another query are subqueries, e.g. not the rows of INSERT ... SELECT
                for (let p = ast.parent(i); p !== null; p = ast.parent(p)) {
                    if (ast.type(p) === T.OBJECT_SQL_SELECT) {
                        operators.add('subquery');
                        break;
                    }
                }
                break;
            }
        }
    }

    return {
        statementTypes,
        tables: uniqueSorted(tables),
        columns: uniqueSorted(columns),
        functions: uniqueSorted(functions),
        aggregates: uniqueSorted(aggregates),
        functionCalls: uniqueSorted(calls),
        ctes: uniqueSorted(ctes),
        joins: uniqueSorted(joins),
        filters: uniqueSorted(filters),
        operators: [...operators].sort((a, b) => operatorRank(a) - operatorRank(b) || a.localeCompare(b)),
        outputColumns,
        groupBy: [...groupBy],
        orderBy: [...orderBy],
        visualizations: sql.visualization ? describeVisualization(sql.visualization) : [],
    };
}
