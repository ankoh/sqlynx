import { PlatformLogger, LogLevel } from './platform_logger.js';
import { LogBuffer } from './log_buffer.js';

export class WebLogger implements PlatformLogger {
    buffer: LogBuffer;

    constructor(buffer: LogBuffer) {
        this.buffer = buffer;
    }

    /// Destroy the logger
    public async destroy(): Promise<void> { }

    /// Log a message
    log(level: LogLevel, message: string): Promise<void> {
        this.buffer.push({ level, message });
        return Promise.resolve();
    }

    /// Log a trace message
    public trace(message: string): Promise<void> {
        return this.log(LogLevel.Trace, message);
    }
    /// Log an info message
    public info(message: string): Promise<void> {
        return this.log(LogLevel.Info, message);
    }
    /// Log a warning message
    public warn(message: string): Promise<void> {
        return this.log(LogLevel.Warn, message);
    }
    /// Log an error message
    public async error(message: string): Promise<void> {
        return this.log(LogLevel.Error, message);
    }
};
