import * as app_event from '@ankoh/dashql-jsonschema/app_event.js';
import * as buf from "@bufbuild/protobuf";

import { BASE64URL_CODEC } from '../../utils/base64.js';
import { Logger } from '../logger/logger.js';
import { PlatformDragDropEventVariant, SETUP_SESSION, SETUP_SESSION_URL, SetupEventVariant } from './event.js';

const LOG_CTX = "event_listener";
export const EVENT_QUERY_PARAMETER = "data";
export const SESSION_QUERY_PARAMETER = "session";

type ClipboardSetup =
    | { type: "event", value: string }
    | { type: "session", value: string };

export function parseClipboardSetup(text: string): ClipboardSetup | null {
    let url: URL;
    try {
        url = new URL(text.trim());
    } catch {
        return null;
    }

    const isDashQLLink = url.protocol === "dashql:" && url.hostname === "localhost";
    const isProductionLink = url.protocol === "https:" && url.hostname === "dashql.app" && url.port === "";
    const isDevelopmentLink = url.protocol === "http:" && url.hostname === "localhost" && url.port === "9002";
    if ((!isDashQLLink && !isProductionLink && !isDevelopmentLink) || url.username !== "" || url.password !== "") {
        return null;
    }

    const eventData = url.searchParams.get(EVENT_QUERY_PARAMETER);
    if (eventData) return { type: "event", value: eventData };
    const sessionUrl = url.searchParams.get(SESSION_QUERY_PARAMETER);
    return sessionUrl ? { type: "session", value: sessionUrl } : null;
}

// An oauth subscriber
interface OAuthSubscriber {
    /// Resolve the promise with oauth redirect data
    resolve: (data: app_event.OAuthRedirectData) => void;
    /// Reject with an error
    reject: (err: Error) => void;
    /// The abort signal provided by the client
    signal: AbortSignal;
    /// The listener for client cancellation
    abortListener: () => void;
    accepts: (data: app_event.OAuthRedirectData) => boolean;
}

export abstract class PlatformEventListener {
    /// The logger
    protected logger: Logger;

    /// The oauth subscriber.
    /// There can only be a single OAuth subscriber at a single point in time.
    private oAuthSubscriber: OAuthSubscriber | null = null;
    /// The setup subscriber.
    /// There can only be a single navigation subscribe at a single point in time
    private setupSubscriber: ((data: SetupEventVariant) => void) | null = null;
    /// The queued session setup (if any)
    private queuedSetupEvent: SetupEventVariant | null;
    /// The clipboard subscriber
    private clipboardEventHandler: (e: ClipboardEvent) => void;
    /// Whether global event listeners are installed
    private isSetup: boolean;
    /// The drag event subscriber
    private dragDropEventSubscribers: Map<string, (e: PlatformDragDropEventVariant) => void>;
    /// Subscribers for pasted text not handled as an app event
    private fallbackPasteSubscribers: Set<(text: string) => void>;

    /// Constructor
    constructor(logger: Logger) {
        this.logger = logger;
        this.oAuthSubscriber = null;
        this.setupSubscriber = null;
        this.queuedSetupEvent = null;
        this.clipboardEventHandler = this.processClipboardEvent.bind(this);
        this.dragDropEventSubscribers = new Map();
        this.fallbackPasteSubscribers = new Set();
        this.isSetup = false;
    }

    /// Method to setup the listener
    public async setup(): Promise<void> {
        if (this.isSetup) return;
        this.isSetup = true;
        await this.listenForAppEvents();
        this.listenForClipboardEvents();
    }
    /// Remove global event listeners
    public dispose(): void {
        if (!this.isSetup) return;
        this.isSetup = false;
        document.removeEventListener("paste", this.clipboardEventHandler, true);
        this.stopListeningForAppEvents();
        this.dragDropEventSubscribers.clear();
        this.fallbackPasteSubscribers.clear();
    }

    /// Method to setup the listener for app events
    protected abstract listenForAppEvents(): Promise<void>;
    /// Method to remove app event listeners
    protected abstract stopListeningForAppEvents(): void;

    /// Called by subclasses when receiving an app event
    public dispatchAppEvent(event: app_event.AppEventData) {
        if ('oauthRedirect' in event) {
            this.dispatchOAuthRedirect(event.oauthRedirect);
        } else if ('session' in event) {
            // Decode base64url session data to Uint8Array
            const sessionBuffer = BASE64URL_CODEC.decode(event.session);
            const sessionBytes = new Uint8Array(sessionBuffer);
            const setupEvent: SetupEventVariant = {
                type: SETUP_SESSION,
                value: sessionBytes
            };
            this.dispatchSetup(setupEvent);
        }
    }

    public dispatchSessionUrl(url: string): void {
        this.dispatchSetup({ type: SETUP_SESSION_URL, value: url });
    }

    /// Received navigation event
    protected dispatchSetup(event: SetupEventVariant) {
        if (!this.setupSubscriber) {
            this.logger.info("Queuing setup event since there's no registered subscriber", {}, LOG_CTX);
            this.queuedSetupEvent = event;
        } else {
            this.setupSubscriber(event);
        }
    }
    /// OAuth succeeded, let the subscriber now
    protected dispatchOAuthRedirect(data: app_event.OAuthRedirectData) {
        if (!this.oAuthSubscriber) {
            console.warn("Received oauth redirect data but there's no registered oauth subscriber", {}, LOG_CTX);
        } else {
            const sub = this.oAuthSubscriber;
            if (!sub.accepts(data)) {
                return;
            }
            sub.signal.removeEventListener("abort", sub.abortListener!);
            this.oAuthSubscriber = null;
            if (!sub.signal.aborted) {
                sub.resolve(data)
            }
        }
    }
    /// Dispatch a drag/drop event to all subscribers
    protected dispatchDragDrop(event: PlatformDragDropEventVariant) {
        for (const [_k, v] of this.dragDropEventSubscribers) {
            v(event);
        }
    }

    /// Wait for the oauth code to arrive
    public async waitForOAuthRedirect(
        signal: AbortSignal,
        accepts: (data: app_event.OAuthRedirectData) => boolean = () => true,
    ): Promise<app_event.OAuthRedirectData> {
        // Already set?
        if (this.oAuthSubscriber != null) {
            // Just throw, we don't support multiple outstanding listeners
            return Promise.reject(new Error("duplicate oauth listener"));
        } else {
            // Setup the subscriber
            return new Promise<app_event.OAuthRedirectData>((resolve, reject) => {
                const subscriber: OAuthSubscriber = {
                    signal,
                    resolve,
                    reject,
                    accepts,
                    abortListener: () => { }
                };
                subscriber.abortListener = () => {
                    const sub = this.oAuthSubscriber;
                    if (!sub) {
                        return;
                    }
                    this.oAuthSubscriber = null;
                    sub.signal.removeEventListener("abort", sub.abortListener!);
                    sub.reject({
                        name: "AbortError",
                        message: "Waiting for oauth code was aborted"
                    });
                }
                signal.addEventListener("abort", subscriber.abortListener);
                this.oAuthSubscriber = subscriber;
            });
        }
    }

    /// Subscribe navigation events
    public subscribeSetupEvents(handler: (data: SetupEventVariant) => void): void {
        if (this.setupSubscriber) {
            this.logger.warn("Tried to register more than one session setup subscriber", {}, LOG_CTX);
            return;
        }
        this.logger.info("Subscribing to session setup events", {}, LOG_CTX);
        this.setupSubscriber = handler;

        // Is there a pending session setup?
        if (this.queuedSetupEvent != null) {
            const setup = this.queuedSetupEvent;
            this.queuedSetupEvent = null;
            this.logger.info("Dispatching buffered session setup event", {}, LOG_CTX);
            this.setupSubscriber(setup);
        }
    }
    /// Unsubscribe from session setup events
    public unsubscribeSetupEvents(handler: (data: SetupEventVariant) => void): void {
        if (this.setupSubscriber != handler) {
            this.logger.warn("Tried to unregister a session setup subscriber that is not registered", {}, LOG_CTX);
        } else {
            this.setupSubscriber = null;
        }
    }

    /// Subscribe drag-drop events
    public subscribeDragDropEvents(key: string, handler: (data: PlatformDragDropEventVariant) => void): void {
        this.dragDropEventSubscribers.set(key, handler);
    }
    /// Unsubscribe drag-drop events
    public unsubscribeDragDropEvents(key: string): void {
        this.dragDropEventSubscribers.delete(key);
    }

    /// Subscribe to pasted text that is not recognized as an app event
    public subscribeFallbackPasteEvents(handler: (text: string) => void): void {
        this.fallbackPasteSubscribers.add(handler);
    }
    /// Unsubscribe from fallback paste events
    public unsubscribeFallbackPasteEvents(handler: (text: string) => void): void {
        this.fallbackPasteSubscribers.delete(handler);
    }

    /// Method to listen for pasted dashql links
    private listenForClipboardEvents() {
        this.logger.info("Subscribing to clipboard events", {}, LOG_CTX);
        // Use capture phase on document so we see paste events even when an input field
        // has focus (inputs otherwise consume the event before it reaches window).
        document.addEventListener("paste", this.clipboardEventHandler, true);
    }

    /// Helper to unpack app link data
    public readAppEvent(dataBase64: any, fromWhat: string) {
        // Make sure everything arriving here is a valid base64 string
        if (!dataBase64 || typeof dataBase64 !== 'string') {
            this.logger.trace("Skipping app event with non-string data", {}, LOG_CTX);
            return null;
        }
        if (dataBase64.startsWith("webpackHotUpdate")) {
            this.logger.debug("Received hot update", {
                event: dataBase64,
            }, LOG_CTX);
            return null;
        }
        // Is a valid base64?
        if (!BASE64URL_CODEC.isValidBase64(dataBase64)) {
            this.logger.trace("Skipping app event with invalid base64 data", {}, LOG_CTX);
            return null;
        }
        // Try to parse as app event data
        try {
            const dataBuffer = BASE64URL_CODEC.decode(dataBase64);
            const dataJson = new TextDecoder().decode(dataBuffer);
            const event: app_event.AppEventData = JSON.parse(dataJson);
            this.logger.info(`Parsed app event`, {}, LOG_CTX);
            return event;

        } catch (error: any) {
            this.logger.info(`Event does not encode valid link data`, { "source": fromWhat }, LOG_CTX);

            return null;
        }
    }


    /// Helper to process a clipboard event
    private processClipboardEvent(event: ClipboardEvent) {
        const clipboardText = event.clipboardData?.getData("text/plain") ?? null;
        if (clipboardText == null) return;
        const pastedText = clipboardText.trim();

        const setup = parseClipboardSetup(pastedText);
        let eventData: string | null = null;
        if (setup?.type === "event") {
            eventData = setup.value;
        } else if (setup?.type === "session") {
            event.preventDefault();
            event.stopPropagation();
            this.dispatchSessionUrl(setup.value);
            return;
        } else if (BASE64URL_CODEC.isValidBase64(pastedText)) {
            // Raw base64 event data pasted directly (web opener flow fallback)
            eventData = pastedText;
        } else {
            this.dispatchFallbackPaste(event, clipboardText);
            return;
        }

        const data = this.readAppEvent(eventData, `clipboard data`);
        if (data != null) {
            event.preventDefault();
            event.stopPropagation();
            this.dispatchAppEvent(data);
        } else {
            this.dispatchFallbackPaste(event, clipboardText);
        }
    }

    private dispatchFallbackPaste(event: ClipboardEvent, text: string): void {
        if (this.fallbackPasteSubscribers.size === 0) return;
        event.preventDefault();
        event.stopPropagation();
        for (const subscriber of this.fallbackPasteSubscribers) {
            subscriber(text);
        }
    }
}
