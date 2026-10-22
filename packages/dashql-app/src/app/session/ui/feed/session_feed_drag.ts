import type { UniqueIdentifier } from '@dnd-kit/core';

export interface FeedDragEntry {
    scriptId: number;
    fileName: string;
}

export function reorderFeedEntries<T extends FeedDragEntry>(
    entries: readonly T[],
    activeId: UniqueIdentifier,
    overId: UniqueIdentifier,
): T[] | null {
    const from = entries.findIndex(entry => entry.scriptId === activeId);
    const to = entries.findIndex(entry => entry.scriptId === overId);
    if (from < 0 || to < 0 || from === to) return null;
    const reordered = [...entries];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    return reordered;
}
