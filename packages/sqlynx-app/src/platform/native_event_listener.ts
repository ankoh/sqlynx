import { UnlistenFn, listen } from "@tauri-apps/api/event";

import { Logger } from './logger.js';
import { AppEventListener } from "./event_listener.js";

const NATIVE_EVENT_CHANNEL = "sqlynx:event";

export class NativeAppEventListener extends AppEventListener {
    unlistenNativeEvents: Promise<UnlistenFn> | null;

    constructor(logger: Logger) {
        super(logger);
        this.unlistenNativeEvents = null;
    }

    public listenForAppEvents() {
        this.unlistenNativeEvents = listen(NATIVE_EVENT_CHANNEL, (event: any) => {
            let data = this.readAppEvent(event.payload.message, `${NATIVE_EVENT_CHANNEL} message`);
            if (data != null) {
                super.dispatchAppEvent(data);
            }
        });
    }
}
