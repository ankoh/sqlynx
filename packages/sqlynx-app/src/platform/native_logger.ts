import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { LogLevel } from './log_buffer.js';
import { Logger } from './logger.js';

enum RustLogLevel {
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
    Trace = 5,
}

/// The Rust log::LogLevel is flipped.
/// Events arriving at log://log are apparently storing the Rust log level:
/// https://github.com/tauri-apps/plugins-workspace/issues/1193
function rustToWebLogLevel(level: RustLogLevel): LogLevel {
    switch (level) {
        case RustLogLevel.Trace: return LogLevel.Trace;
        case RustLogLevel.Debug: return LogLevel.Debug;
        case RustLogLevel.Info: return LogLevel.Info;
        case RustLogLevel.Warn: return LogLevel.Warn;
        case RustLogLevel.Error: return LogLevel.Error;
    }
}

export class NativeLogger extends Logger {
    unlistener: Promise<UnlistenFn>;

    constructor() {
        super();
        this.unlistener = listen("log://log", (event: any) => {
            const record = JSON.parse(event.payload.message) as any;
            record.level = rustToWebLogLevel(record.level as RustLogLevel);
            this.outputBuffer.push(record);
        });
    }

    /// Destroy the logger
    public async destroy(): Promise<void> {
        const unlisten = await this.unlistener;
        unlisten();
    }
    /// Helper to flush pending records
    protected flushPendingRecords(): void {
        if (this.pendingRecords.length == 0) {
            return;
        }
        const pending = this.pendingRecords;
        this.pendingRecords = [];
        for (let i = 0; i < pending.length; ++i) {
            const record = pending[i];
            invoke("plugin:log|log", {
                level: record.level,
                message: record.message,
                location: record.target
            });
        }
    }
};
