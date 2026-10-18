/// Split text into chunks of at most `maxTokens`, preferring paragraph, line and sentence boundaries.
/// Neighbouring chunks share up to `overlapTokens` of trailing context.
export function chunkText(
    text: string,
    maxTokens: number,
    countTokens: (text: string) => number,
    overlapTokens = 0,
): string[] {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return [];
    }
    if (countTokens(trimmed) <= maxTokens) {
        return [trimmed];
    }
    const units = splitUnits(trimmed, maxTokens, countTokens);
    const chunks: string[] = [];
    let current: { text: string; tokens: number }[] = [];
    let currentTokens = 0;
    for (const unit of units) {
        const tokens = countTokens(unit.text);
        if (current.length > 0 && currentTokens + tokens > maxTokens) {
            chunks.push(join(current));
            // Carry trailing units into the next chunk as overlap
            const carry: typeof current = [];
            let carried = 0;
            for (let i = current.length - 1; i >= 0 && carried + current[i].tokens <= overlapTokens; --i) {
                carry.unshift(current[i]);
                carried += current[i].tokens;
            }
            current = carry;
            currentTokens = carried;
            if (currentTokens + tokens > maxTokens) {
                current = [];
                currentTokens = 0;
            }
        }
        current.push({ text: unit.text, tokens });
        currentTokens += tokens;
    }
    if (current.length > 0) {
        chunks.push(join(current));
    }
    return chunks;
}

function join(units: { text: string }[]): string {
    return units.map(u => u.text).join('\n').trim();
}

interface Unit {
    text: string;
}

/// Break the text into units that each fit the budget
function splitUnits(text: string, maxTokens: number, countTokens: (text: string) => number): Unit[] {
    const out: Unit[] = [];
    const levels: RegExp[] = [/\n{2,}/, /\n/, /(?<=[.!?])\s+/, /\s+/];
    const split = (piece: string, level: number): void => {
        const trimmed = piece.trim();
        if (trimmed.length === 0) return;
        if (countTokens(trimmed) <= maxTokens || level >= levels.length) {
            out.push({ text: trimmed });
            return;
        }
        for (const part of trimmed.split(levels[level])) {
            split(part, level + 1);
        }
    };
    split(text, 0);
    return out;
}
