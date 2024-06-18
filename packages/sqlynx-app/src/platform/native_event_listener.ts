import { UnlistenFn, listen } from "@tauri-apps/api/event";

import { Logger } from './logger.js';
import { AppEventListener } from "./event_listener.js";

const LOG_CTX = "native_event_listener";

const NATIVE_EVENT_CHANNEL = "sqlynx:event";

export class NativeAppEventListener extends AppEventListener {
    unlistenNativeEvents: Promise<UnlistenFn> | null;

    constructor(logger: Logger) {
        super(logger);
        this.unlistenNativeEvents = null;
    }

    public listenForAppEvents() {
        this.unlistenNativeEvents = listen(NATIVE_EVENT_CHANNEL, (event: any) => {
            const events = event.payload as string[];
            this.logger.debug(`received native app events: ${events.toString()}`, LOG_CTX);
            for (const event of events) {
                const data = this.readAppEvent(event, `${NATIVE_EVENT_CHANNEL} message`);
                if (data != null) {
                    super.dispatchAppEvent(data);
                }
            }
        });
    }
}
