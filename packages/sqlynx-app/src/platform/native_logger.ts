import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { LogRecord } from './log_buffer.js';
import { Logger } from './logger.js';

export class NativeLogger extends Logger {
    unlistener: Promise<UnlistenFn>;

    constructor() {
        super();
        this.unlistener = listen("log://log", (event: any) => {
            const record = JSON.parse(event.payload.message) as LogRecord;
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
