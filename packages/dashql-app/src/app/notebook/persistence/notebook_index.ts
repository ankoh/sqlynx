import { type NotebookIndexData, type ScriptData, type DataFile, validateDataFileName } from './storage_backend.js';

const NATURAL_SORT = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function createNotebookIndex(scripts: readonly ScriptData[], data: readonly DataFile[] = []): NotebookIndexData {
    for (const file of data) validateDataFileName(file.name);
    return {
        scripts: scripts
            .map(script => ({ name: script.name }))
            .sort((a, b) => NATURAL_SORT.compare(a.name, b.name)),
        ...(data.length > 0 ? { data: data.map(file => ({ name: file.name }))
            .sort((a, b) => NATURAL_SORT.compare(a.name, b.name)) } : {}),
    };
}

export function serializeNotebookIndex(scripts: readonly ScriptData[], data: readonly DataFile[] = []): string {
    return JSON.stringify(createNotebookIndex(scripts, data), null, 2);
}
