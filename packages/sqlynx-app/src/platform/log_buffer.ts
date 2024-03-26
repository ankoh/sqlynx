export enum LogLevel {
    Trace = 1,
    Debug,
    Info,
    Warn,
    Error,
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

/// A log record
export interface LogRecord {
    /// The log level
    level: LogLevel;
    /// A message
    message: string;
}

const TARGET_CHUNK_SIZE = 1024;

class FrozenLogChunk {
    readonly entries: LogRecord[];

    constructor(entries: LogRecord[]) {
        entries.reverse();
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

    constructor() {
        this.version_ = 1;
        this.lastEntries_ = [];
        this.frozenChunks_ = [];
        this.logObservers = new Set();
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
        if (index < this.lastEntries_.length) {
            return this.lastEntries_[this.lastEntries_.length - 1 - index];
        }
        const frozenIndex = index - this.lastEntries_.length;
        const chunkIndex = Math.floor(frozenIndex / TARGET_CHUNK_SIZE);
        const indexInChunk = frozenIndex - (chunkIndex * TARGET_CHUNK_SIZE);
        if (chunkIndex >= this.frozenChunks_.length) {
            return null;
        }
        const chunk = this.frozenChunks_[chunkIndex];
        if (indexInChunk >= chunk.entries.length) {
            return null;
        }
        return chunk.entries[indexInChunk];
    }
}
