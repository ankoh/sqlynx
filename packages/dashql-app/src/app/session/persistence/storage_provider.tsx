import * as React from 'react';
import { StorageWriter } from './storage_writer.js';
import { type StorageBackend, StorageBackendType } from './storage_backend.js';
import { OPFSStorageBackend } from './opfs_storage_backend.js';
import { CompositeStorageBackend } from './composite_storage_backend.js';
import { type SessionLocation } from './session_locator.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import type { DashQL } from '@ankoh/dashql-core';
import { restoreAppState, type RestoredAppState, type AppStateRestorationProgress } from './app_state_loader.js';

// Storage context for the writer
const StorageWriterContext = React.createContext<StorageWriter | null>(null);

// Storage context for reading
export interface StorageReader {
    backend: StorageBackend;
    restoreAppState(core: DashQL, progressConsumer: (progress: AppStateRestorationProgress) => void): Promise<RestoredAppState>;
    waitForInitialRestore(): Promise<void>;
    /// The physical location of a session's files (used by the UI for a display path).
    getSessionLocation(sessionId: string): SessionLocation;
    /// The user-facing session order (manifest array order), as session UUIDs. Empty for a bare
    /// backend without per-session routing.
    getSessionOrder(): string[];
}
const StorageReaderContext = React.createContext<StorageReader | null>(null);

interface StorageProviderProps {
    backend?: StorageBackend;
    children?: React.ReactNode;
}

export const StorageProvider: React.FC<StorageProviderProps> = ({ backend: providedBackend, children }) => {
    const logger = useLogger();
    const [backend, setBackend] = React.useState<StorageBackend | null>(providedBackend || null);

    // Initialize the configured backend if no backend was provided
    React.useEffect(() => {
        if (providedBackend) {
            logger.info("Using provided storage backend", {}, "storage_provider");
            setBackend(providedBackend);
            return;
        }

        const initBackend = async () => {
            const initStartTime = performance.now();

            logger.info("Initializing storage backend", {}, "storage_provider");
            const opfsBackend = new OPFSStorageBackend();
            const composite = new CompositeStorageBackend(opfsBackend, logger);
            await composite.initialize();

            const initDuration = performance.now() - initStartTime;
            logger.info("Storage backend initialized", {
                backend: composite.getBackendType(),
                durationMs: initDuration.toFixed(2)
            }, "storage_provider");

            setBackend(composite);
        };

        initBackend();
    }, [providedBackend]);

    // Create storage writer instance
    const writer = React.useMemo(() => {
        if (!backend) return null;
        return new StorageWriter(logger, backend);
    }, [logger, backend]);


    // Create storage reader
    const reader = React.useMemo<StorageReader | null>(() => {
        if (!backend) return null;

        return {
            backend,
            async restoreAppState(core: DashQL, progressConsumer: (progress: AppStateRestorationProgress) => void): Promise<RestoredAppState> {
                return restoreAppState(core, backend, logger, progressConsumer);
            },
            async waitForInitialRestore(): Promise<void> {
                // Nothing to wait for in current implementation
                return Promise.resolve();
            },
            getSessionLocation(sessionId: string): SessionLocation {
                if (backend instanceof CompositeStorageBackend) {
                    return backend.getSessionLocation(sessionId);
                }
                // A bare backend (e.g. an injected test backend) has no per-session routing.
                return { type: backend.getBackendType() === StorageBackendType.Native ? StorageBackendType.Native : StorageBackendType.OPFS };
            },
            getSessionOrder(): string[] {
                if (backend instanceof CompositeStorageBackend) {
                    return backend.getSessionOrder();
                }
                // A bare backend has no manifest-order registry; the caller falls back to its own order.
                return [];
            },
        };
    }, [backend, logger]);

    if (!backend || !writer || !reader) {
        // Still initializing
        return null;
    }

    return (
        <StorageReaderContext.Provider value={reader}>
            <StorageWriterContext.Provider value={writer}>
                {children}
            </StorageWriterContext.Provider>
        </StorageReaderContext.Provider>
    );
};

export function useStorageWriter(): StorageWriter {
    const writer = React.useContext(StorageWriterContext);
    if (!writer) {
        throw new Error('useStorageWriter must be used within StorageProvider');
    }
    return writer;
}

export function useStorage(): [StorageReader, StorageWriter] {
    const reader = React.useContext(StorageReaderContext);
    const writer = React.useContext(StorageWriterContext);
    if (!reader || !writer) {
        throw new Error('useStorage must be used within StorageProvider');
    }
    return [reader, writer];
}

export function useStorageReader(): StorageReader {
    const reader = React.useContext(StorageReaderContext);
    if (!reader) {
        throw new Error('useStorageReader must be used within StorageProvider');
    }
    return reader;
}
