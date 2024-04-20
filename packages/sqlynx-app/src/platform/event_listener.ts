import * as proto from '@ankoh/sqlynx-pb';

import { Logger } from './logger.js';

// An oauth subscriber
interface OAuthSubscriber {
    /// Resolve the promise with oauth redirect data
    resolve: (data: proto.sqlynx_oauth.pb.OAuthRedirectData) => void;
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
    /// The navigation subscriber.
    /// There can only be a single navigation subscribe at a single point in time
    private navigateToSubscriber: ((data: proto.sqlynx_app_event.pb.NavigateTo) => void) | null = null;
    /// The clipboard subscriber
    private clipboardEventHandler: (e: ClipboardEvent) => void;

    /// Constructor
    constructor(logger: Logger) {
        this.logger = logger;
        this.oAuthSubscriber = null;
        this.navigateToSubscriber = null;
        this.clipboardEventHandler = this.processClipboardEvent.bind(this);
    }

    /// Method to setup the listener
    public setup() {
        this.listenForAppEvents();
        this.listenForClipboardEvents();
    }

    /// Method to setup the listener for app events
    protected abstract listenForAppEvents(): void;

    /// Called by subclasses when receiving an app event
    protected dispatchAppEvent(event: proto.sqlynx_app_event.pb.AppEvent) {
        switch (event.eventData.case) {
            case "oauthRedirect": {
                this.dispatchOAuthRedirect(event.eventData.value);
                break;
            }
            case "navigateTo": {
                this.dispatchNavigateTo(event.eventData.value);
                break;
            }
        }
    }

    /// Received navigation event
    protected dispatchNavigateTo(data: proto.sqlynx_app_event.pb.NavigateTo) {
        if (!this.navigateToSubscriber) {
            console.warn("received navigation event but there's no registered subscriber");
        } else {
            this.navigateToSubscriber(data);
        }
    }

    /// OAuth succeeded, let the subscriber now
    protected dispatchOAuthRedirect(data: proto.sqlynx_oauth.pb.OAuthRedirectData) {
        if (!this.oAuthSubscriber) {
            console.warn("received oauth redirect data but there's no registered oauth subscriber");
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
    public async waitForOAuthRedirect(signal: AbortSignal): Promise<proto.sqlynx_oauth.pb.OAuthRedirectData> {
        // Already set?
        if (this.oAuthSubscriber != null) {
            // Just throw, we don't support multiple outstanding listeners
            return Promise.reject(new Error("duplicate oauth listener"));
        } else {
            // Setup the subscriber
            return new Promise<proto.sqlynx_oauth.pb.OAuthRedirectData>((resolve, reject) => {
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
    public subscribeNavigationEvents(handler: (data: proto.sqlynx_app_event.pb.NavigateTo) => void): void {
        if (this.navigateToSubscriber) {
            this.logger.error("tried to register more than one navigation subscriber");
        } else {
            this.logger.debug("subscribing to navigation events", "event_listener");
            this.navigateToSubscriber = handler;
        }
    }

    /// Method to listen for pasted sqlynx links
    private listenForClipboardEvents() {
        this.logger.debug("subscribing to clipboard events", "event_listener");
        window.addEventListener("paste", this.clipboardEventHandler);
    }

    /// Helper to process a clipboard event
    private processClipboardEvent(event: ClipboardEvent) {
        // Is the pasted text of a deeplink?
        const pastedText = event.clipboardData?.getData("text/plain") ?? null;
        if (pastedText != null && pastedText.startsWith("sqlynx://")) {
            try {
                const deepLink = new URL(pastedText);
                this.logger.info(`received deep link: ${deepLink.toString()}`, "session_setup");

                // Is there a navigation subscriber?
                if (this.navigateToSubscriber) {
                    // Mimic a navigateTo app event
                    const path = deepLink.pathname;
                    const searchParams: { [key: string]: string } = {};
                    for (const [k, v] of deepLink.searchParams) {
                        searchParams[k] = v;
                    }
                    searchParams["deeplink"] = "true";
                    let eventProto = new proto.sqlynx_app_event.pb.NavigateTo({
                        path,
                        searchParams
                    });
                    this.navigateToSubscriber(eventProto);
                } else {
                    this.logger.warn("deep link was pasted to the clipboard but nobody subscribed to NavigateTo events");
                }
                event.preventDefault();
                event.stopPropagation();
            } catch (e: any) {
                console.warn(e);
                this.logger.warn(`parsing deep link failed with error: ${e.toString()}`, "session_setup");
            }
        }
    }

}
