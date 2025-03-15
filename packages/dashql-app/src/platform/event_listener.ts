import * as proto from '@ankoh/dashql-protobuf';

import { BASE64_CODEC } from '../utils/base64.js';
import { Logger } from './logger.js';

const LOG_CTX = "event_listener";
export const EVENT_QUERY_PARAMETER = "data";

// An oauth subscriber
interface OAuthSubscriber {
    /// Resolve the promise with oauth redirect data
    resolve: (data: proto.dashql_oauth.pb.OAuthRedirectData) => void;
    /// Reject with an error
    reject: (err: Error) => void;
    /// The abort signal provided by the client
    signal: AbortSignal;
    /// The listener for client cancellation
    abortListener: () => void;
}

export abstract class AppEventListener {
    /// The logger
    protected logger: Logger;

    /// The oauth subscriber.
    /// There can only be a single OAuth subscriber at a single point in time.
    private oAuthSubscriber: OAuthSubscriber | null = null;
    /// The workbook setup subscriber.
    /// There can only be a single navigation subscribe at a single point in time
    private workbookSetupSubscriber: ((data: proto.dashql_workbook.pb.Workbook) => void) | null = null;
    /// The clipboard subscriber
    private clipboardEventHandler: (e: ClipboardEvent) => void;

    /// The queued workbook setup (if any)
    private queuedWorkbookSetupEvent: proto.dashql_workbook.pb.Workbook | null;

    /// Constructor
    constructor(logger: Logger) {
        this.logger = logger;
        this.oAuthSubscriber = null;
        this.workbookSetupSubscriber = null;
        this.clipboardEventHandler = this.processClipboardEvent.bind(this);
        this.queuedWorkbookSetupEvent = null;
    }

    /// Method to setup the listener
    public setup() {
        this.listenForAppEvents();
        this.listenForClipboardEvents();
    }

    /// Method to setup the listener for app events
    protected abstract listenForAppEvents(): void;

    /// Called by subclasses when receiving an app event
    public dispatchAppEvent(event: proto.dashql_app_event.pb.AppEventData) {
        switch (event.data.case) {
            case "oauthRedirect": {
                this.dispatchOAuthRedirect(event.data.value);
                break;
            }
            case "workbook": {
                this.dispatchWorkbook(event.data.value);
                break;
            }
        }
    }

    /// Received navigation event
    protected dispatchWorkbook(data: proto.dashql_workbook.pb.Workbook) {
        if (!this.workbookSetupSubscriber) {
            this.logger.info("queuing workbook setup event since there's no registered subscriber", {}, LOG_CTX);
            this.queuedWorkbookSetupEvent = data;
        } else {
            this.workbookSetupSubscriber(data);
        }
    }

    /// OAuth succeeded, let the subscriber now
    protected dispatchOAuthRedirect(data: proto.dashql_oauth.pb.OAuthRedirectData) {
        if (!this.oAuthSubscriber) {
            console.warn("received oauth redirect data but there's no registered oauth subscriber", {}, LOG_CTX);
        } else {
            const sub = this.oAuthSubscriber;
            sub.signal.removeEventListener("abort", sub.abortListener!);
            this.oAuthSubscriber = null;
            if (!sub.signal.aborted) {
                sub.resolve(data)
            }
        }
    }

    /// Wait for the oauth code to arrive
    public async waitForOAuthRedirect(signal: AbortSignal): Promise<proto.dashql_oauth.pb.OAuthRedirectData> {
        // Already set?
        if (this.oAuthSubscriber != null) {
            // Just throw, we don't support multiple outstanding listeners
            return Promise.reject(new Error("duplicate oauth listener"));
        } else {
            // Setup the subscriber
            return new Promise<proto.dashql_oauth.pb.OAuthRedirectData>((resolve, reject) => {
                const subscriber: OAuthSubscriber = {
                    signal,
                    resolve,
                    reject,
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
    public subscribeWorkbookSetupEvents(handler: (data: proto.dashql_workbook.pb.Workbook) => void): void {
        if (this.workbookSetupSubscriber) {
            this.logger.error("tried to register more than one workbook setup subscriber", {}, LOG_CTX);
            return;
        }
        this.logger.info("subscribing to workbook setup events", {}, LOG_CTX);
        this.workbookSetupSubscriber = handler;

        // Is there a pending workbook setup?
        if (this.queuedWorkbookSetupEvent != null) {
            const setup = this.queuedWorkbookSetupEvent;
            this.queuedWorkbookSetupEvent = null;
            this.logger.info("dispatching buffered workbook setup event", {}, LOG_CTX);
            this.workbookSetupSubscriber(setup);
        }
    }

    /// Unsubscribe from workbook setup events
    public unsubscribeWorkbookSetupEvents(handler: (data: proto.dashql_workbook.pb.Workbook) => void): void {
        if (this.workbookSetupSubscriber != handler) {
            this.logger.error("tried to unregister a workbook setup subscriber that is not registered", {}, LOG_CTX);
        } else {
            this.workbookSetupSubscriber = null;
        }
    }

    /// Method to listen for pasted dashql links
    private listenForClipboardEvents() {
        this.logger.info("subscribing to clipboard events", {}, LOG_CTX);
        window.addEventListener("paste", this.clipboardEventHandler);
    }

    /// Helper to unpack app link data
    public readAppEvent(dataBase64: any, fromWhat: string) {
        // Make sure everything arriving here is a valid base64 string
        if (!dataBase64 || typeof dataBase64 !== 'string') {
            this.logger.trace("skipping app event with non-string data", {}, LOG_CTX);
            return null;
        }
        // Is a valid base64?
        if (!BASE64_CODEC.isValidBase64(dataBase64)) {
            this.logger.info("skipping app event with invalid base64 data", {}, LOG_CTX);
            return null;
        }
        // Try to parse as app event data
        try {
            const dataBuffer = BASE64_CODEC.decode(dataBase64);
            const dataBytes = new Uint8Array(dataBuffer);
            const event = proto.dashql_app_event.pb.AppEventData.fromBinary(dataBytes);
            this.logger.info(`parsed app event`, { "type": event.data.case }, LOG_CTX);
            return event;

        } catch (error: any) {
            this.logger.error(`event does not encode valid link data`, { "source": fromWhat }, LOG_CTX);
            return null;
        }
    }

    /// Helper to process a clipboard event
    private processClipboardEvent(event: ClipboardEvent) {
        // Is the pasted text of a deeplink?
        const pastedText = event.clipboardData?.getData("text/plain") ?? null;
        if (pastedText != null && pastedText.startsWith("dashql://")) {
            // Get the data parameter
            let deepLinkData: any = null;
            try {
                const deepLink = new URL(pastedText);
                this.logger.info("received deep link", { "link": deepLink.toString() }, LOG_CTX);
                // Has link data?
                deepLinkData = deepLink.searchParams.get(EVENT_QUERY_PARAMETER);
                if (!deepLinkData) {
                    this.logger.warn("deep link lacks the data query parameter", {}, LOG_CTX);
                    return;
                }
            } catch (e: any) {
                console.warn(e);
                this.logger.warn("parsing deep link failed", { "error": e.toString() }, LOG_CTX);
            }

            // Unpack the app event
            const data = this.readAppEvent(deepLinkData, `clipboard data`);
            if (data != null) {
                // Stop propagation of clipboard event
                event.preventDefault();
                event.stopPropagation();

                // Dispatch App Event
                this.dispatchAppEvent(data);
            }
        }
    }
}
