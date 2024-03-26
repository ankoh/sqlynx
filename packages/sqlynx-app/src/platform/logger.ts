import { LogBuffer, LogLevel, LogRecord } from "./log_buffer.js";

/// A platform logger
export abstract class Logger {
    /// The pending log messages
    protected pendingRecords: LogRecord[];
    /// The output log buffer.
    /// To be populated by `flushPendingRecords`
    protected outputBuffer: LogBuffer;

    constructor() {
        this.pendingRecords = [];
        this.outputBuffer = new LogBuffer();
    }

    /// Destroy the logger
    public abstract destroy(): void;
    /// Helper to flush pending records
    protected abstract flushPendingRecords(): void;

    /// Access the log buffer
    public get buffer() { return this.outputBuffer; }

    /// Log a trace message
    public trace(message: string): void {
        this.pendingRecords.push({
            level: LogLevel.Trace,
            message
        });
        this.flushPendingRecords();
    }
    /// Log an info message
    public info(message: string): void {
        this.pendingRecords.push({
            level: LogLevel.Info,
            message
        });
        this.flushPendingRecords();
    }
    /// Log a warning message
    public warn(message: string): void {
        this.pendingRecords.push({
            level: LogLevel.Warn,
            message
        });
        this.flushPendingRecords();
    }
    /// Log an error message
    public error(message: string): void {
        this.pendingRecords.push({
            level: LogLevel.Error,
            message
        });
        this.flushPendingRecords();
    }
}
