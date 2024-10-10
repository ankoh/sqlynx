import { SQLYNX_LOG_LEVEL } from "../globals.js";

export enum LogLevel {
    Trace = 1,
    Debug = 2,
    Info = 3,
    Warn = 4,
    Error = 5,
}

export function getLogLevelName(level: LogLevel): string {
    switch (level) {
        case LogLevel.Trace: return "trace";
        case LogLevel.Debug: return "debug";
        case LogLevel.Info: return "info";
        case LogLevel.Warn: return "warn";
        case LogLevel.Error: return "error";
    }
}

export function parseLogLevel(text: string): LogLevel | null {
    switch (text) {
        case "trace": return LogLevel.Trace;
        case "debug": return LogLevel.Debug;
        case "info": return LogLevel.Info;
        case "warn": return LogLevel.Warn;
        case "error": return LogLevel.Error;
        default:
            return null;
    }
}

/// A log record
export interface LogRecord {
    /// The timestamp
    timestamp: number;
    /// The log level
    level: LogLevel;
    /// The target
    target: string;
    /// A message
    message: string;
}

const TARGET_CHUNK_SIZE = 1024;

class FrozenLogChunk {
    /// The entries of the chunk
    readonly entries: LogRecord[];

    constructor(entries: LogRecord[]) {
        this.entries = entries;
    }
}

type LogObserver = (buffer: LogBuffer) => void;

export class LogBuffer {
    /// Internal version counter
    protected version_: number;
    /// The last entries
    protected lastEntries_: LogRecord[];
    /// The frozen chunks
    protected frozenChunks_: FrozenLogChunk[];
    /// The log observers
    protected logObservers: Set<LogObserver>;
    /// The minimum log level
    protected minLogLevel: LogLevel;

    constructor() {
        this.version_ = 1;
        this.lastEntries_ = [];
        this.frozenChunks_ = [];
        this.logObservers = new Set();
        this.minLogLevel = parseLogLevel(SQLYNX_LOG_LEVEL) ?? LogLevel.Info;
    }

    /// Get the current version
    public get version(): number { return this.version_; }
    /// Get the total amount of log entries
    public get length(): number { return this.lastEntries_.length + this.frozenChunks_.length * TARGET_CHUNK_SIZE; }
    /// Get the observers
    public get observers(): Set<LogObserver> { return this.logObservers; }

    /// Subscribe to log events
    public observe(observer: LogObserver, callWhenRegistering: boolean = false) {
        this.logObservers.add(observer);
        if (callWhenRegistering) {
            observer(this);
        }
    }

    /// Push an entry
    public push(entry: LogRecord) {
        // Ignore the entry
        if (entry.level < this.minLogLevel) {
            return;
        }

        // Buffer entries before compacting
        this.lastEntries_.push(entry);
        // Freeze chunk if forced or above threshold
        if (this.lastEntries_.length > TARGET_CHUNK_SIZE) {
            this.frozenChunks_.push(new FrozenLogChunk(this.lastEntries_));
            this.lastEntries_ = [];
        }
        // Bump the version
        this.version_ += 1;
        // Notify all observers
        for (const observer of this.logObservers) {
            observer(this);
        }
    }

    /// Get at position
    public at(index: number): LogRecord | null {
        const frozenEntries = this.frozenChunks_.length * TARGET_CHUNK_SIZE
        if (index < frozenEntries) {
            const chunkIndex = Math.floor(index / TARGET_CHUNK_SIZE);
            const indexInChunk = index - (chunkIndex * TARGET_CHUNK_SIZE);
            if (chunkIndex >= this.frozenChunks_.length) {
                return null;
            }
            const chunk = this.frozenChunks_[chunkIndex];
            if (indexInChunk >= chunk.entries.length) {
                return null;
            }
            return chunk.entries[indexInChunk];
        }
        const pendingIndex = index - frozenEntries;
        if (pendingIndex < this.lastEntries_.length) {
            return this.lastEntries_[pendingIndex];
        }
        return null;
    }
}
