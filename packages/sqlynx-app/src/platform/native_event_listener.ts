import { UnlistenFn, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

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

    // Best-effort attempt to read the initial deep links after setting up the event listener
    protected async readInitialDeepLinkEvents() {
        try {
            const currentLinks: string[] = await invoke("plugin:deep-link|get_current");
            for (const currentLink of currentLinks) {
                const url = new URL(currentLink);
                const search = url.searchParams;
                const data = search.get("data");
                if (data) {
                    const event = this.readAppEvent(data, "initial deep link");
                    if (event != null) {
                        super.dispatchAppEvent(event);
                    }
                }
            }
        } catch (e: any) {
            console.warn(e)
        }
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

        // Read the initial deep link events
        this.readInitialDeepLinkEvents();
    }
}
