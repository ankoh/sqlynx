import { Logger } from './logger.js';
import { PlatformEventListener } from "./event_listener.js";
import { WebFile } from './web_file.js';
import { DRAG_EVENT, DRAG_STOP_EVENT, DROP_EVENT, PlatformDragEvent, PlatformDropEvent } from './event.js';

export class WebPlatformEventListener extends PlatformEventListener {
    onWindowMessage: (event: any) => void;

    constructor(logger: Logger) {
        super(logger);
        this.onWindowMessage = this.processMessageEvent.bind(this);
    }

    public async listenForAppEvents(): Promise<void> {
        const listener = this;
        window.addEventListener("message", this.onWindowMessage);
        window.addEventListener("dragover", function(e: DragEvent) {
            // Prevent default to enable drop events
            e.preventDefault();

            const event: PlatformDragEvent = {
                pageX: e.pageX as number,
                pageY: e.pageY as number,
            };
            listener.dispatchDragDrop({
                type: DRAG_EVENT,
                value: event
            });
        });
        window.addEventListener("dragend", function(e: DragEvent) {
            // Prevent default to enable drop events
            e.preventDefault();
            console.log("DRAG_END");

            const event: PlatformDragEvent = {
                pageX: e.pageX as number,
                pageY: e.pageY as number,
            };
            listener.dispatchDragDrop({
                type: DRAG_STOP_EVENT,
                value: event
            });
        });
        window.addEventListener("drop", (e: DragEvent) => {
            // Prevent default drop handler
            e.preventDefault();

            if (e.dataTransfer) {
                for (let i = 0; i < e.dataTransfer.files.length; ++i) {
                    const file = e.dataTransfer.files.item(i);
                    if (file) {
                        const event: PlatformDropEvent = {
                            pageX: e.pageX as number,
                            pageY: e.pageY as number,
                            file: new WebFile(file, file.name),
                        };
                        listener.dispatchDragDrop({
                            type: DROP_EVENT,
                            value: event
                        });
                    }
                }
            }
        });
    }

    protected processMessageEvent(event: MessageEvent) {
        const data = this.readAppEvent(event.data, `event message`);
        if (data != null) {
            // Message was a valid base64 AND parsed as AppEvent?
            // Assume it's ours.
            event.stopPropagation();
            event.preventDefault();
            // Dispatch App Event
            super.dispatchAppEvent(data);
        }
    }
}
