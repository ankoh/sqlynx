// An oauth subscriber
interface OAuthSubscriber {
    resolve: (code: string) => void;
    reject: (err: Error) => void;
    signal: AbortSignal;
    abortListener: () => void;
}

export class OAuthListener {
    /// The subscriber
    subscriber: OAuthSubscriber | null = null;

    constructor() {
        this.subscriber = null;
    }

    /// Helper to react to an abort signal
    protected handleAbort() {
        if (!this.subscriber) {
            return;
        }
        const sub = this.subscriber;
        this.subscriber = null;
        sub.signal.removeEventListener("abort", sub.abortListener!);
        sub.reject({
            name: "AbortError",
            message: "Waiting for oauth code was aborted"
        });
    }

    /// Wait for the oauth code to arrive
    public async waitForOAuthCode(signal: AbortSignal): Promise<string> {
        // Already set?
        if (this.subscriber != null) {
            // Just throw, we don't support multiple outstanding listeners
            return Promise.reject(new Error("duplicate oauth listener"));
        } else {
            // Setup the subscriber
            return new Promise<string>((resolve, reject) => {
                const subscriber: OAuthSubscriber = {
                    signal,
                    resolve,
                    reject,
                    abortListener: this.handleAbort.bind(this)
                };
                signal.addEventListener("abort", subscriber.abortListener);
                this.subscriber = subscriber;
            });
        }
    }

    /// OAuth succeeded, let the subscriber now
    protected oauthSucceeded(code: string) {
        if (!this.subscriber) {
            console.warn("received oauth code but there's no registered oauth subscriber");
        } else {
            const sub = this.subscriber;
            sub.signal.removeEventListener("abort", sub.abortListener!);
            this.subscriber = null;
            if (!sub.signal.aborted) {
                sub.resolve(code);
            }
        }
    }

    /// OAuth failed, let the subscriber now
    protected oauthFailed(code: string) {
        if (!this.subscriber) {
            console.warn("received oauth error but there's no registered oauth subscriber");
        } else {
            const sub = this.subscriber;
            sub.signal.removeEventListener("abort", sub.abortListener!);
            this.subscriber = null;
            if (!sub.signal.aborted) {
                sub.resolve(code);
            }
        }
    }
}
