import { UnlistenFn, listen } from "@tauri-apps/api/event";
import { DragDropEvent, getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";

import { Logger } from './logger.js';
import { PlatformEventListener } from "./event_listener.js";
import { NativeFile } from "./native_file.js";
import { DRAG_EVENT, DRAG_STOP_EVENT, DROP_EVENT, PlatformDragEvent, PlatformDropEvent } from "./event.js";

const LOG_CTX = "native_event_listener";

const NATIVE_EVENT_CHANNEL = "dashql:event";

export class NativePlatformEventListener extends PlatformEventListener {
    unlistenNativeEvents: Promise<UnlistenFn> | null;
    unlistenDndEvents: Promise<UnlistenFn> | null;

    constructor(logger: Logger) {
        super(logger);
        this.unlistenNativeEvents = null;
        this.unlistenDndEvents = null;
    }

    // Best-effort attempt to read the initial deep links after setting up the event listener
    protected async readInitialDeepLinkEvents() {
        try {
            const currentLinks: string[] = await invoke("plugin:deep-link|get_current");
            if (currentLinks != null) {
                this.logger.info("reading initial deep links", { "count": currentLinks.length.toString() }, LOG_CTX);

                for (const currentLink of currentLinks) {
                    const url = new URL(currentLink);
                    const search = url.searchParams;
                    const data = search.get("data");
                    if (data) {
                        const event = this.readAppEvent(data, "initial deep link");
                        if (event != null) {
                            this.logger.info("initial deep link is an app event", { "event": event?.data.case }, LOG_CTX);
                            super.dispatchAppEvent(event);
                        }
                    }
                }
            } else {
                this.logger.info(`reading initial deep links, received null`, {}, LOG_CTX);
            }
        } catch (e: any) {
            console.warn(e)
        }
    }

    public async listenForAppEvents(): Promise<void> {
        this.unlistenNativeEvents = listen(NATIVE_EVENT_CHANNEL, (event: any) => {
            const events = event.payload as string[];
            this.logger.debug(`received native app events`, { "count": events.length.toString() }, LOG_CTX);
            for (const event of events) {
                const data = this.readAppEvent(event, `${NATIVE_EVENT_CHANNEL} message`);
                if (data != null) {
                    super.dispatchAppEvent(data);
                }
            }
        });
        const listener = this;
        this.unlistenDndEvents = await getCurrentWebview().onDragDropEvent((e: DragDropEvent) => {
            const rawEvent: any = e as any;
            if (rawEvent.payload.type === 'over') {
                const pos = rawEvent.payload.position;
                const mapped: PlatformDragEvent = {
                    pageX: pos.x,
                    pageY: pos.y,
                };
                listener.dispatchDragDrop({
                    type: DRAG_EVENT,
                    value: mapped
                });

            } else if (rawEvent.payload.type === 'drop') {
                for (let i = 0; i < rawEvent.payload.paths.length; ++i) {
                    const path = rawEvent.payload.paths[i];
                    const pos = rawEvent.payload.position;
                    const event: PlatformDropEvent = {
                        pageX: pos.x,
                        pageY: pos.y,
                        file: new NativeFile(path),
                    };
                    listener.dispatchDragDrop({
                        type: DROP_EVENT,
                        value: event
                    });
                }
            } else {

                const pos = rawEvent.payload.position;
                const mapped: PlatformDragEvent = {
                    pageX: pos.x,
                    pageY: pos.y,
                };
                listener.dispatchDragDrop({
                    type: DRAG_STOP_EVENT,
                    value: mapped
                });
            }
        });

        // Read the initial deep link events
        this.readInitialDeepLinkEvents();
    }
}
