import { Logger } from '../logger/logger.js';
import { WebPlatformEventListener } from './web_event_listener.js';

const LOG_CTX = "electron_event_listener";

export class ElectronPlatformEventListener extends WebPlatformEventListener {
    private unsubscribeDeepLinks: (() => void) | null = null;

    public async listenForAppEvents(): Promise<void> {
        await super.listenForAppEvents();
        const bridge = globalThis.dashqlElectron;
        if (bridge === undefined) {
            this.logger.warn("Electron bridge is unavailable", {}, LOG_CTX);
            return;
        }

        const dispatch = (link: { type: "event" | "session"; value: string }, source: string) => {
            if (link.type === "session") {
                this.dispatchSessionUrl(link.value);
                return;
            }
            const event = this.readAppEvent(link.value, source);
            if (event !== null) super.dispatchAppEvent(event);
        };
        this.unsubscribeDeepLinks = bridge.onDeepLink((link) => dispatch(link, "Electron deep link"));
        for (const link of await bridge.getInitialDeepLinks()) {
            dispatch(link, "initial Electron deep link");
        }
    }

    protected stopListeningForAppEvents(): void {
        this.unsubscribeDeepLinks?.();
        this.unsubscribeDeepLinks = null;
        super.stopListeningForAppEvents();
    }
}
