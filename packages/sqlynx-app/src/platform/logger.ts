import { LogBuffer, LogLevel, LogRecord } from "./log_buffer.js";

/// A helper for log statistics
export class LogStatistics {
    /// The max width of the target column
    public maxTargetWidth: number;
    /// The max width of the message column
    public maxMessageWidth: number;

    constructor() {
        this.maxTargetWidth = 0;
        this.maxMessageWidth = 0;
    }

    /// Push a log record
    public push(record: LogRecord) {
        this.maxTargetWidth = Math.max(record.target.length, this.maxTargetWidth);
        this.maxMessageWidth = Math.max(record.message.length, this.maxMessageWidth);
    }
}

/// A platform logger
export abstract class Logger {
    /// The pending log messages
    protected pendingRecords: LogRecord[];
    /// The output log buffer.
    /// To be populated by `flushPendingRecords`
    protected outputBuffer: LogBuffer;
    /// The log statistics
    protected logStatistics: LogStatistics;

    constructor() {
        this.pendingRecords = [];
        this.outputBuffer = new LogBuffer();
        this.logStatistics = new LogStatistics();
    }

    /// Destroy the logger
    public abstract destroy(): void;
    /// Helper to flush pending records
    protected abstract flushPendingRecords(): void;

    /// Access the log buffer
    public get buffer() { return this.outputBuffer; }
    /// Access the log statistics
    public get statistics() { return this.logStatistics; }

    /// Log a trace message
    public trace(message: string, target?: string): void {
        const entry = {
            timestamp: Date.now(),
            level: LogLevel.Trace,
            target: target ?? "pwa:unknown",
            message,
        };
        this.pendingRecords.push(entry);
        this.logStatistics.push(entry);
        this.flushPendingRecords();
    }
    /// Log an debug message
    public debug(message: string, target?: string): void {
        const entry = {
            timestamp: Date.now(),
            level: LogLevel.Debug,
            target: target ?? "pwa:unknown",
            message,
        };
        this.pendingRecords.push(entry);
        this.logStatistics.push(entry);
        this.flushPendingRecords();
    }
    /// Log an info message
    public info(message: string, target?: string): void {
        const entry = {
            timestamp: Date.now(),
            level: LogLevel.Info,
            target: target ?? "pwa:unknown",
            message,
        };
        this.pendingRecords.push(entry);
        this.logStatistics.push(entry);
        this.flushPendingRecords();
    }
    /// Log a warning message
    public warn(message: string, target?: string): void {
        const entry = {
            timestamp: Date.now(),
            level: LogLevel.Warn,
            target: target ?? "pwa:unknown",
            message,
        };
        this.pendingRecords.push(entry);
        this.logStatistics.push(entry);
        this.flushPendingRecords();
    }
    /// Log an error message
    public error(message: string, target?: string): void {
        const entry = {
            timestamp: Date.now(),
            level: LogLevel.Warn,
            target: target ?? "pwa:unknown",
            message,
        };
        this.pendingRecords.push(entry);
        this.logStatistics.push(entry);
        this.flushPendingRecords();
    }
}
