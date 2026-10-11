import * as flatbuffers from 'flatbuffers';
import * as buffers from '@ankoh/dashql-core/buffers';
import type { DashQL, DashQLCatalog, DashQLScript } from '@ankoh/dashql-core';
import type { BatchRequest, BatchResult } from '@ankoh/dashql-core';
import { createBatchWorker, type DashQLBatchWorker } from '@ankoh/dashql-core/browser-worker';

export type BatchProcessor = (request: BatchRequest) => Promise<BatchResult>;

export interface CatalogBatchEntry {
    script: DashQLScript;
    text: string;
    rank: number;
    requireFunctions?: boolean;
}

export interface CatalogBatchOptions {
    abortSignal?: AbortSignal;
    isCurrent?: () => boolean;
    processor?: BatchProcessor;
}

const workers = new WeakMap<DashQL, DashQLBatchWorker>();
const lifetimes = new WeakMap<DashQL, AbortController>();
const generations = new WeakMap<DashQLCatalog, number>();

function getCatalogBatchWorker(core: DashQL): DashQLBatchWorker {
    const worker = workers.get(core);
    if (!worker?.isInitialized) throw new Error('Core batch worker is not initialized; enable setupBatchWorker during initial setup');
    return worker;
}

export async function initializeCatalogBatchWorker(core: DashQL): Promise<void> {
    lifetimes.get(core)?.signal.throwIfAborted();
    let worker = workers.get(core);
    if (!worker) {
        worker = createBatchWorker();
        workers.set(core, worker);
        lifetimes.set(core, new AbortController());
    }
    await worker.initialize();
}

/// The core provider explicitly sets up and owns the worker lifecycle.
export function disposeCatalogBatchWorker(core: DashQL): void {
    // Keep the aborted signal for response continuations already queued before disposal.
    lifetimes.get(core)?.abort();
    workers.get(core)?.dispose();
    workers.delete(core);
}

export function invalidateCatalogBatch(catalog: DashQLCatalog): void {
    generations.set(catalog, (generations.get(catalog) ?? 0) + 1);
}

/// Begin before fetching metadata, not after it, so a slow fetch cannot supersede a newer refresh.
export function beginCatalogBatch(catalog: DashQLCatalog, options: CatalogBatchOptions = {}): () => void {
    invalidateCatalogBatch(catalog);
    const generation = generations.get(catalog);
    return () => {
        if (options.abortSignal?.aborted || generations.get(catalog) !== generation || options.isCurrent?.() === false) {
            throw new DOMException('Catalog refresh was cancelled or superseded', 'AbortError');
        }
    };
}

function batchRequest(entries: CatalogBatchEntry[]): BatchRequest {
    return { scripts: entries.map(entry => ({
        id: entry.script.catalog_entry_id.toString(),
        text: entry.text,
        outputs: ['catalogDescriptor'],
    })) };
}

function commitCatalogBatch(catalog: DashQLCatalog, entries: CatalogBatchEntry[], result: BatchResult, validate: () => void) {
    validate();
    if (result.scripts.length !== entries.length) throw new Error('Catalog batch returned an unexpected script count');
    const prepared = entries.map(entry => {
        const matches = result.scripts.filter(script => script.id === entry.script.catalog_entry_id.toString());
        const output = matches[0];
        if (matches.length !== 1 || output.failure) {
            throw new Error(output?.failure ?? 'Catalog batch did not return a descriptor');
        }
        const error = output.diagnostics.find(diagnostic => diagnostic.severity === 'error');
        if (error) throw new Error(`Catalog contains invalid SQL: ${error.message}`);
        if (!output.catalogDescriptor?.length) throw new Error('Catalog batch did not return a descriptor');
        const descriptor = buffers.catalog.CatalogDescriptor.getRootAsCatalogDescriptor(new flatbuffers.ByteBuffer(output.catalogDescriptor));
        const counts = { tables: descriptor.tablesLength(), functions: descriptor.functionDeclarationsLength() };
        if (entry.requireFunctions && counts.functions === 0) throw new Error('Hyper function catalog is empty');
        return { descriptor: output.catalogDescriptor, counts };
    });

    validate();
    for (let i = 0; i < entries.length; ++i) {
        const entry = entries[i];
        const previousText = entry.script.toString();
        try {
            entry.script.replaceText(entry.text);
            catalog.replaceDescriptor(entry.script.catalog_entry_id, entry.rank, prepared[i].descriptor);
        } catch (error) {
            try {
                entry.script.replaceText(previousText);
            } catch {
                // Preserve the import/write failure if restoring this source also fails.
            }
            throw error;
        }
    }
    return prepared.map(entry => entry.counts);
}

export async function publishCatalogBatch(
    core: DashQL,
    catalog: DashQLCatalog,
    entries: CatalogBatchEntry[],
    options: CatalogBatchOptions = {},
    validate = beginCatalogBatch(catalog, options),
) {
    validate();
    if (entries.length === 0) return [];
    let lifetime = lifetimes.get(core);
    if (!lifetime) {
        lifetime = new AbortController();
        lifetimes.set(core, lifetime);
    }
    const validateBatch = validate;
    validate = () => {
        lifetime.signal.throwIfAborted();
        validateBatch();
    };
    validate();
    const processor = options.processor ?? ((request: BatchRequest) => getCatalogBatchWorker(core).processBatch(request));
    let onAbort: (() => void) | undefined;
    try {
        const cancelled = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new DOMException('Catalog refresh was cancelled', 'AbortError'));
            options.abortSignal?.addEventListener('abort', onAbort, { once: true });
            lifetime.signal.addEventListener('abort', onAbort, { once: true });
            if (options.abortSignal?.aborted) onAbort();
        });
        const processing = new Promise<BatchResult>(resolve => resolve(processor(batchRequest(entries))));
        const result = await Promise.race([processing, cancelled]);
        validate();
        return commitCatalogBatch(catalog, entries, result, validate);
    } catch (error) {
        // A late worker failure from a disposed/superseded refresh is cancellation, not a
        // failure of the newer catalog. Promise.race also consumes late worker rejections.
        validate();
        throw error;
    } finally {
        if (onAbort) {
            options.abortSignal?.removeEventListener('abort', onAbort);
            lifetime.signal.removeEventListener('abort', onAbort);
        }
    }
}

/// Synchronous callers (initial prefetched functions and storage reconciliation) still prepare
/// isolated batch descriptors, never scan/parse/analyze the persistence scripts on the main catalog.
export function publishCatalogBatchSync(core: DashQL, catalog: DashQLCatalog, entries: CatalogBatchEntry[]) {
    const validate = beginCatalogBatch(catalog);
    if (entries.length === 0) return [];
    return commitCatalogBatch(catalog, entries, core.processBatch(batchRequest(entries)), validate);
}
