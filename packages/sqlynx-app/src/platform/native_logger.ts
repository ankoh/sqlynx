import { PlatformLogger, LogLevel, LogRecord } from './platform_logger.js';
import { NativeGlobals, Unlistener } from './native_globals.js';
import { LogBuffer } from './log_buffer.js';

export class NativeLogger implements PlatformLogger {
    globals: NativeGlobals;
    buffer: LogBuffer;
    unlistener: Promise<Unlistener>;

    constructor(globals: NativeGlobals, buffer: LogBuffer) {
        this.globals = globals;
        this.buffer = buffer;
        this.unlistener = globals.event.listen("log://log", (event: any) => {
            this.buffer.push(event as LogRecord);
        });
    }

    /// Destroy the logger
    public async destroy(): Promise<void> {
        const unlisten = await this.unlistener;
        unlisten();
    }

    /// Log a message
    log(level: LogLevel, message: string): Promise<void> {
        return this.globals.core.invoke("plugin:log|log", {
            level,
            message,
        });
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
