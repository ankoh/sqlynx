import * as proto from '@ankoh/sqlynx-pb';

import { Logger } from './logger.js';

// An oauth subscriber
interface OAuthSubscriber {
    resolve: (data: proto.sqlynx_oauth.pb.OAuthRedirectData) => void;
    reject: (err: Error) => void;
    signal: AbortSignal;
    abortListener: () => void;
}

export abstract class AppEventListener {
    /// The logger
    logger: Logger;
    /// The subscriber
    oAuthSubscriber: OAuthSubscriber | null = null;

    /// Constructor
    constructor(logger: Logger) {
        this.logger = logger;
        this.oAuthSubscriber = null;
    }

    /// Method to setup the listener
    public abstract listen(): void;

    /// Called by subclasses when receiving an app event
    protected dispatchAppEvent(event: proto.sqlynx_app_event.pb.AppEvent) {
        // Seems to be a valid AppEvent, now we know something
        switch (event.eventData.case) {
            case "oauthRedirect": {
                this.onOAuthRedirect(event.eventData.value);
                break;
            }
        }
    }

    /// OAuth succeeded, let the subscriber now
    protected onOAuthRedirect(data: proto.sqlynx_oauth.pb.OAuthRedirectData) {
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
    public async waitForOAuthCode(signal: AbortSignal): Promise<proto.sqlynx_oauth.pb.OAuthRedirectData> {
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
}
