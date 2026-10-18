import { DESCRIPTION_BEGIN, DESCRIPTION_END, type CommentBlock } from './analysis/comments.js';

// A copy of this file lives in packages/dashql-app/src/atlas/describe/header.ts, keep them in sync

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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concatBytes(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/// Insert or replace the generated description block of a script, followed by a blank line.
/// Everything outside of the marked range and that blank line stays untouched.
/// A new description goes after the metadata block if the script starts with one, the metadata is never touched.
export function applyHeader(
    text: string,
    comments: CommentBlock[],
    description: Description,
    force: boolean,
): { text: string; action: HeaderAction } {
    const eol = detectEol(text);
    const header = renderHeader(description, eol);
    const existing = comments.find(c => c.source === 'dashql_description');
    if (existing && !force) {
        return { text, action: 'kept' };
    }
    // The offsets of the comment blocks are UTF-8 byte offsets
    const bytes = encoder.encode(text);
    // Skip the line break of the old block and the blank line after it, if any
    const skipLineBreak = (offset: number) =>
        bytes[offset] === 0x0d && bytes[offset + 1] === 0x0a ? offset + 2 : bytes[offset] === 0x0a ? offset + 1 : offset;
    if (!existing) {
        const metadata = comments.find(c => c.source === 'dashql_metadata');
        const leading = metadata !== undefined && decoder.decode(bytes.subarray(0, metadata.begin)).trim() === '';
        if (!leading) {
            return { text: header + eol + text, action: 'inserted' };
        }
        // Keep the blank line after the metadata, or add one
        const afterBreak = skipLineBreak(metadata.end);
        const afterBlank = skipLineBreak(afterBreak);
        const separator = afterBlank > afterBreak ? '' : afterBreak > metadata.end ? eol : eol + eol;
        const out = concatBytes([
            bytes.subarray(0, afterBlank),
            encoder.encode(separator + header + eol),
            bytes.subarray(afterBlank),
        ]);
        return { text: decoder.decode(out), action: 'inserted' };
    }
    const end = skipLineBreak(skipLineBreak(existing.end));
    const out = concatBytes([bytes.subarray(0, existing.begin), encoder.encode(header + eol), bytes.subarray(end)]);
    return { text: decoder.decode(out), action: 'replaced' };
}
