import { LogRecord } from "./platform_logger.js";

const TARGET_CHUNK_SIZE = 1024;

class FrozenLogChunk {
    readonly entries: LogRecord[];

    constructor(entries: LogRecord[]) {
        entries.reverse();
        this.entries = entries;
    }
}

export class LogBuffer {
    /// Internal version counter
    protected version_: number;
    /// The last entries
    protected lastEntries_: LogRecord[];
    /// The frozen chunks
    protected frozenChunks_: FrozenLogChunk[];

    constructor() {
        this.version_ = 1;
        this.lastEntries_ = [];
        this.frozenChunks_ = [];
    }

    /// Get the current version
    public get version(): number { return this.version_; }
    /// Get the total amount of log entries
    public get length(): number { return this.lastEntries_.length + this.frozenChunks_.length * TARGET_CHUNK_SIZE; }

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
    }

    /// Get at position
    public at(index: number): LogRecord | null {
        if (this.lastEntries_.length < index) {
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
