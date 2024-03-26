/// A log level
export enum LogLevel {
    Trace = 1,
    Debug,
    Info,
    Warn,
    Error,
}
/// A log record
export interface LogRecord {
    /// The log level
    level: LogLevel;
    /// A message
    message: string;
}

/// A platform logger
export interface PlatformLogger {
    /// Destroy the logger
    destroy(): Promise<void>;

    /// Log a trace message
    trace(message: string): Promise<void>;
    /// Log an info message
    info(message: string): Promise<void>;
    /// Log a warning message
    warn(message: string): Promise<void>;
    /// Log an error message
    error(message: string): Promise<void>;
}
