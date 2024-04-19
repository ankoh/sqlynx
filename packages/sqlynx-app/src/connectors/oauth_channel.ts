// An oauth subscriber
interface OAuthSubscriber {
    resolve: (code: string) => void;
    reject: (err: Error) => void;
    signal: AbortSignal;
    abortListener: () => void;
}

let OAUTH_SUBSCRIBER: OAuthSubscriber | null = null;

/// Helper to react to an abort signal
function listenForAborts() {
    if (!OAUTH_SUBSCRIBER) {
        return;
    }
    const subscriber = OAUTH_SUBSCRIBER;
    OAUTH_SUBSCRIBER = null;
    subscriber.signal.removeEventListener("abort", subscriber.abortListener!);
    subscriber.reject({
        name: "AbortError",
        message: "Waiting for oauth code was aborted"
    });
}

/// Wait for the oauth code to arrive
export function waitForOAuthCode(signal: AbortSignal): Promise<string> {
    // Already set?
    if (OAUTH_SUBSCRIBER != null) {
        // Just throw, we don't support multiple outstanding listeners
        return Promise.reject(new Error("duplicate oauth listener"));
    } else {
        // Setup the subscriber
        return new Promise<string>((resolve, reject) => {
            const subscriber: OAuthSubscriber = {
                signal,
                resolve,
                reject,
                abortListener: listenForAborts
            };
            signal.addEventListener("abort", subscriber.abortListener);
            OAUTH_SUBSCRIBER = subscriber;
        });
    }
}

/// OAuth succeeded, let the subscriber now
export function oauthSucceeded(code: string) {
    if (!OAUTH_SUBSCRIBER) {
        console.warn("received oauth code but there's no registered oauth subscriber");
    } else {
        const subscriber = OAUTH_SUBSCRIBER;
        subscriber.signal.removeEventListener("abort", subscriber.abortListener!);
        OAUTH_SUBSCRIBER = null;
        if (!subscriber.signal.aborted) {
            subscriber.resolve(code);
        }
    }
}

/// OAuth failed, let the subscriber now
export function oauthFailed(code: string) {
    if (!OAUTH_SUBSCRIBER) {
        console.warn("received oauth error but there's no registered oauth subscriber");
    } else {
        const subscriber = OAUTH_SUBSCRIBER;
        subscriber.signal.removeEventListener("abort", subscriber.abortListener!);
        OAUTH_SUBSCRIBER = null;
        if (!subscriber.signal.aborted) {
            subscriber.resolve(code);
        }
    }
}
