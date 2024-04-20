import * as proto from '@ankoh/sqlynx-pb';

import { Logger } from './logger.js';
import { BASE64_CODEC } from '../utils/base64.js';
import { UnlistenFn, listen } from "@tauri-apps/api/event";
import { AppEventListener } from "./event_listener.js";

const NATIVE_EVENT_CHANNEL = "sqlynx:event";

export class NativeAppEventListener extends AppEventListener {
    unlistener: Promise<UnlistenFn> | null;

    constructor(logger: Logger) {
        super(logger);
        this.unlistener = null;
    }

    public listen() {
        this.unlistener = listen(NATIVE_EVENT_CHANNEL, (event: any) => {
            // Make sure everything arriving here is a valid base64 string
            const dataBase64 = event.payload.message as string;
            if (!dataBase64 || typeof dataBase64 !== 'string') {
                this.logger.error(`message arriving at '${NATIVE_EVENT_CHANNEL}' is not a string`);
                return;
            }
            // Is a valid base64?
            if (!BASE64_CODEC.isValidBase64(dataBase64)) {
                this.logger.error(`message string arriving at '${NATIVE_EVENT_CHANNEL}' is not encoded as base64`);
                return;
            }
            // Try to parse as AppEvent
            let eventProto: proto.sqlynx_app_event.pb.AppEvent;
            try {
                const dataBuffer = BASE64_CODEC.decode(dataBase64);
                const dataBytes = new Uint8Array(dataBuffer);
                eventProto = proto.sqlynx_app_event.pb.AppEvent.fromBinary(dataBytes);
            } catch (error: any) {
                this.logger.error(`message arriving at '${NATIVE_EVENT_CHANNEL}' is not a valid AppEvent`);
                return;
            }
            // Dispatch the AppEvent
            super.dispatchAppEvent(eventProto);
        });
    }
}
