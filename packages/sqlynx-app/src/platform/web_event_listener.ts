import { Logger } from './logger.js';
import { AppEventListener } from "./event_listener.js";

export class WebAppEventListener extends AppEventListener {
    onWindowMessage: (event: any) => void;

    constructor(logger: Logger) {
        super(logger);
        this.onWindowMessage = this.processMessageEvent.bind(this);
    }

    public listenForAppEvents() {
        window.addEventListener("message", this.onWindowMessage);
    }

    protected processMessageEvent(event: MessageEvent) {
        let data = this.readAppEvent(event.data, `event message`);
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
