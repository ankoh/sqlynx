import { DESCRIPTION_BEGIN, DESCRIPTION_END, type CommentBlock } from '../analysis/comments.js';

export interface Description {
    summary: string;
    questions: string[];
}

const DEFAULT_WIDTH = 100;

/// Word-wrap text with a first-line and a continuation prefix
function wrap(text: string, firstPrefix: string, nextPrefix: string, width: number): string[] {
    const lines: string[] = [];
    let line = firstPrefix;
    let empty = true;
    for (const word of text.split(/\s+/).filter(w => w.length > 0)) {
        if (!empty && line.length + 1 + word.length > width) {
            lines.push(line);
            line = nextPrefix;
            empty = true;
        }
        line += (empty ? '' : ' ') + word;
        empty = false;
    }
    lines.push(line);
    return lines;
}

export function detectEol(text: string): string {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

/// Render the description block, including the trailing line break
export function renderHeader(description: Description, eol: string, width = DEFAULT_WIDTH): string {
    const lines = [`-- ${DESCRIPTION_BEGIN}`];
    lines.push(...wrap(description.summary, '-- ', '-- ', width));
    if (description.questions.length > 0) {
        lines.push('--', '-- Example questions:');
        for (const question of description.questions) {
            lines.push(...wrap(question, '-- - ', '--   ', width));
        }
    }
    lines.push(`-- ${DESCRIPTION_END}`);
    return lines.join(eol) + eol;
}

export type HeaderAction = 'inserted' | 'replaced' | 'kept';

/// Insert or replace the generated description block of a script.
/// Everything outside of the marked range stays untouched.
export function applyHeader(
    text: string,
    comments: CommentBlock[],
    description: Description,
    force: boolean,
): { text: string; action: HeaderAction } {
    const eol = detectEol(text);
    const header = renderHeader(description, eol);
    const existing = comments.find(c => c.source === 'dashql_description');
    if (!existing) {
        return { text: header + text, action: 'inserted' };
    }
    if (!force) {
        return { text, action: 'kept' };
    }
    const bytes = Buffer.from(text, 'utf8');
    let end = existing.end;
    if (bytes[end] === 0x0d && bytes[end + 1] === 0x0a) end += 2;
    else if (bytes[end] === 0x0a) end += 1;
    const out = Buffer.concat([bytes.subarray(0, existing.begin), Buffer.from(header, 'utf8'), bytes.subarray(end)]);
    return { text: out.toString('utf8'), action: 'replaced' };
}
