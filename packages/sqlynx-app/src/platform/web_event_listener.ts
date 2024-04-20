import * as proto from '@ankoh/sqlynx-pb';

import { Logger } from './logger.js';
import { AppEventListener } from "./event_listener.js";
import { BASE64_CODEC } from '../utils/base64.js';

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
        // Very defensively check if it's our message.
        // We're subscribing to ALL window messages after all and should not assume anything.
        const data = event.data;
        if (!data || typeof data !== 'string') {
            return;
        }
        // Is a valid base64?
        if (!BASE64_CODEC.isValidBase64(data)) {
            return;
        }
        // Try to parse as AppEvent
        let eventProto: proto.sqlynx_app_event.pb.AppEvent;
        try {
            const dataBuffer = BASE64_CODEC.decode(data);
            const dataBytes = new Uint8Array(dataBuffer);
            eventProto = proto.sqlynx_app_event.pb.AppEvent.fromBinary(dataBytes);
        } catch (e: any) {
            // Silenty swallow the error, we still can't know that this is targeting us.
            return;
        }
        // Message was a valid base64 AND parsed as AppEvent?
        // Assume it's ours.
        event.stopPropagation();
        event.preventDefault();

        // Dispatch the event
        super.dispatchAppEvent(eventProto);
    }
}
