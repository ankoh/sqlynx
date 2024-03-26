import { LogRecord } from './log_buffer.js';
import { NativeGlobals, Unlistener } from './native_globals.js';
import { Logger } from './logger.js';

export class NativeLogger extends Logger {
    globals: NativeGlobals;
    unlistener: Promise<Unlistener>;

    constructor(globals: NativeGlobals) {
        super();
        this.globals = globals;
        this.unlistener = globals.event.listen("log://log", (event: any) => {
            this.outputBuffer.push(event as LogRecord);
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
        this.pendingRecords = [];
        const pending = this.pendingRecords;
        for (let i = 0; i < pending.length; ++i) {
            const record = pending[i];
            this.globals.core.invoke("plugin:log|log", {
                level: record.level,
                message: record.message,
            });
        }
    }
};
