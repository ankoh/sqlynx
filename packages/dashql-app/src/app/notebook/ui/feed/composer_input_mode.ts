import * as core from '@ankoh/dashql-core';

const TokenType = core.buffers.parser.ScannerTokenType;
const DiagnosticSource = core.buffers.editor.EditorDiagnosticSource;
const DiagnosticSeverity = core.buffers.editor.EditorDiagnosticSeverity;

/// AI -> SQL: a viable prefix with this many settled tokens is SQL
const ENTER_MIN_TOKENS = 3;
/// AI -> SQL: a shorter viable prefix is SQL if it has a token that is not an identifier after the leading keyword
const ENTER_MIN_TOKENS_WITH_SQL_SYNTAX = 2;
/// SQL -> AI: the invalid tail needs at least this many tokens
const EXIT_MIN_TAIL = 2;
/// SQL -> AI: the invalid tail needs at least this share of the valid prefix, long SQL holds on longer
const EXIT_TAIL_RATIO = 0.5;
/// SQL -> AI: the invalid tail reads as natural language below this share of SQL-shaped tokens
const NL_TAIL_MAX_SQL_SHARE = 0.35;

/// The input mode of the composer
export enum ComposerInputMode {
    /// The draft is a SQL script
    Sql,
    /// The draft is a question in natural language
    Ai,
}

/// How much a draft looks like SQL
export interface SqlEvidence {
    /// Is the first settled token a keyword?
    leadingKeyword: boolean;
    /// The number of settled tokens before the first scanner or parser error
    validTokens: number;
    /// The number of valid tokens after the leading one that are not identifiers
    validSqlTokens: number;
    /// The number of settled tokens from the first scanner or parser error on
    tailTokens: number;
    /// The summed SQL weight of the tail tokens, see tokenSqlWeight
    tailSqlWeight: number;
    /// Is the text free of any scanner or parser error, including an error at the end of the input?
    complete: boolean;
}

/// How strongly a token suggests SQL rather than natural language.
/// English is mostly identifiers with a few keywords (by, for, all), SQL brings operators, literals and punctuation.
function tokenSqlWeight(tokenType: core.buffers.parser.ScannerTokenType): number {
    switch (tokenType) {
        case TokenType.IDENTIFIER:
            return 0;
        case TokenType.KEYWORD:
        case TokenType.KEYWORD_VIS:
            return 0.5;
        default:
            return 1;
    }
}

/// Can the token still grow while the cursor sits at its end?
function isGrowingToken(tokenType: core.buffers.parser.ScannerTokenType): boolean {
    switch (tokenType) {
        case TokenType.IDENTIFIER:
        case TokenType.KEYWORD:
        case TokenType.KEYWORD_VIS:
        case TokenType.LITERAL_INTEGER:
        case TokenType.LITERAL_FLOAT:
            return true;
        default:
            return false;
    }
}

/// Collect the evidence of an editor update.
///
/// The token the user is still typing (cursor at its end) is not settled and is ignored, partial words must not switch the mode.
/// Pass a null cursor to settle every token, e.g. when the draft is sent.
export function assessSql(update: core.buffers.editor.EditorUpdateT, cursor: number | null): SqlEvidence {
    // The first scanner or parser error, diagnostics are sorted by offset
    let errorOffset: number | null = null;
    const scannerErrors: [number, number][] = [];
    for (const diagnostic of update.diagnostics) {
        if (diagnostic.severity !== DiagnosticSeverity.ERROR || diagnostic.source === DiagnosticSource.ANALYZER) {
            continue;
        }
        const offset = Number(diagnostic.textSpan?.offset ?? 0);
        const length = Number(diagnostic.textSpan?.length ?? 0);
        if (errorOffset == null) {
            errorOffset = offset;
        }
        if (diagnostic.source === DiagnosticSource.SCANNER) {
            scannerErrors.push([offset, offset + length]);
        }
    }

    // The settled tokens
    const tokens: { type: core.buffers.parser.ScannerTokenType, begin: number, end: number }[] = [];
    for (const span of update.syntaxSpans) {
        if (span.tokenType === TokenType.COMMENT) {
            continue;
        }
        const begin = Number(span.textSpan?.offset ?? 0);
        tokens.push({ type: span.tokenType, begin, end: begin + Number(span.textSpan?.length ?? 0) });
    }
    const last = tokens[tokens.length - 1];
    if (cursor != null && last != null && last.end === cursor && isGrowingToken(last.type)) {
        tokens.pop();
    }

    const evidence: SqlEvidence = {
        leadingKeyword: tokens.length > 0 && (tokens[0].type === TokenType.KEYWORD || tokens[0].type === TokenType.KEYWORD_VIS),
        validTokens: 0,
        validSqlTokens: 0,
        tailTokens: 0,
        tailSqlWeight: 0,
        complete: errorOffset == null,
    };
    for (let i = 0; i < tokens.length; ++i) {
        const token = tokens[i];
        if (errorOffset == null || token.begin < errorOffset) {
            evidence.validTokens += 1;
            if (i > 0 && token.type !== TokenType.IDENTIFIER) {
                evidence.validSqlTokens += 1;
            }
        } else {
            evidence.tailTokens += 1;
            // Text swallowed by a scanner error (e.g. an unterminated string after an apostrophe) is no evidence of SQL
            const garbage = scannerErrors.some(([begin, end]) => token.begin < end && begin < token.end);
            evidence.tailSqlWeight += garbage ? 0 : tokenSqlWeight(token.type);
        }
    }
    return evidence;
}

/// Decide the next input mode.
///
/// The switch is asymmetric to avoid flicker: entering SQL needs a viable prefix with some substance, leaving SQL
/// needs an invalid tail that reads as natural language and that grows with the length of the valid SQL.
/// A final decision (when the draft is sent) also accepts any complete statement that starts with a keyword.
export function decideMode(current: ComposerInputMode, evidence: SqlEvidence, final: boolean = false): ComposerInputMode {
    if (current === ComposerInputMode.Ai) {
        if (!evidence.leadingKeyword || evidence.tailTokens > 0) {
            return current;
        }
        if (final && evidence.complete) {
            return ComposerInputMode.Sql;
        }
        const substantial = evidence.validTokens >= ENTER_MIN_TOKENS
            || (evidence.validTokens >= ENTER_MIN_TOKENS_WITH_SQL_SYNTAX && evidence.validSqlTokens > 0);
        return substantial ? ComposerInputMode.Sql : current;
    } else {
        const minTail = Math.max(EXIT_MIN_TAIL, Math.ceil(evidence.validTokens * EXIT_TAIL_RATIO));
        if (evidence.tailTokens < minTail) {
            return current;
        }
        const naturalTail = evidence.tailSqlWeight / evidence.tailTokens < NL_TAIL_MAX_SQL_SHARE;
        return naturalTail ? ComposerInputMode.Ai : current;
    }
}
