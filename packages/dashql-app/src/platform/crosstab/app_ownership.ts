/// The Web Lock that the tab owning the app holds while it runs
export const APP_OWNERSHIP_LOCK = 'dashql-app';
/// The channel on which tabs ask the owner to hand over the app
export const APP_OWNERSHIP_CHANNEL = 'dashql-app';
/// The message that asks the owner to hand over the app
const HANDOFF_REQUEST = 'handoff';

/// How a tab reaches the other tabs of the app
export interface AppOwnershipEnvironment {
    /// The lock manager of the tab
    locks: LockManager;
    /// Open a broadcast channel of the tab
    openChannel: (name: string) => BroadcastChannel;
    /// The name of the ownership lock
    lockName?: string;
    /// The name of the handoff channel
    channelName?: string;
}

/// The default environment of the current tab, null if the browser has no Web Locks
export function getAppOwnershipEnvironment(): AppOwnershipEnvironment | null {
    if (typeof navigator === 'undefined' || navigator.locks == null || typeof BroadcastChannel === 'undefined') {
        return null;
    }
    return { locks: navigator.locks, openChannel: name => new BroadcastChannel(name) };
}

/// The owner did not hand over the app in time
export class AppOwnershipTimeoutError extends Error {
    constructor() {
        super('The tab that owns the app did not hand it over');
        this.name = 'AppOwnershipTimeoutError';
    }
}

/// The ownership of the app storage by one tab.
///
/// All tabs of the origin share the OPFS root, and every tab keeps the state it loaded in memory. Only
/// one tab may therefore load and write the storage at a time. That tab holds the Web Lock of the app
/// until it is closed or hands the app over.
///
/// A tab takes over by queueing a request for the lock and asking the owner on the broadcast channel.
/// The owner stops writing and returns from the lock callback, the lock manager then grants the
/// lock to the queued request. The new owner cannot start before the old owner stopped, so the
/// handoff needs no acknowledgement. The lock is never stolen: an owner that doesn't respond keeps
/// the app until its tab is closed.
export class AppOwnership {
    /// Resolves when the lock was released, after a handoff or `dispose`
    public readonly released: Promise<void>;

    private constructor(
        private readonly channel: BroadcastChannel,
        private readonly release: () => void,
        released: Promise<void>,
    ) {
        this.released = released;
    }

    /// Acquire the ownership if no other tab owns the app.
    ///
    /// `handOver` stops every writer of the app storage when another tab asks for the app. The lock is
    /// released when it settles.
    static async tryAcquire(env: AppOwnershipEnvironment, handOver: () => Promise<void>): Promise<AppOwnership | null> {
        return await AppOwnership.hold(env, handOver, { ifAvailable: true }, crypto.randomUUID());
    }

    /// Take over the app from the owning tab.
    ///
    /// Rejects with `AppOwnershipTimeoutError` when the owner doesn't hand over the app within the
    /// timeout. The request is withdrawn then, the owner keeps the app.
    static async takeOver(env: AppOwnershipEnvironment, handOver: () => Promise<void>, timeoutMs: number): Promise<AppOwnership> {
        const requester = crypto.randomUUID();
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        const acquired = AppOwnership.hold(env, handOver, { signal: abort.signal }, requester, () => clearTimeout(timer));
        // Lock requests and queries share the queue of the lock manager. Once the query returns, the
        // request is queued and receives the lock when the owner releases it.
        await env.locks.query();
        const channel = env.openChannel(env.channelName ?? APP_OWNERSHIP_CHANNEL);
        channel.postMessage({ type: HANDOFF_REQUEST, requester });
        channel.close();
        try {
            const ownership = await acquired;
            return ownership!;
        } catch (error) {
            if ((error as DOMException).name === 'AbortError') {
                throw new AppOwnershipTimeoutError();
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /// Hold the lock until the ownership is handed over or released
    private static hold(
        env: AppOwnershipEnvironment,
        handOver: () => Promise<void>,
        options: LockOptions,
        id: string,
        onGranted?: () => void,
    ): Promise<AppOwnership | null> {
        return new Promise<AppOwnership | null>((resolve, reject) => {
            const request = env.locks.request(env.lockName ?? APP_OWNERSHIP_LOCK, options, async lock => {
                if (lock == null) {
                    resolve(null);
                    return;
                }
                onGranted?.();
                let release!: () => void;
                const done = new Promise<void>(r => { release = r; });
                const channel = env.openChannel(env.channelName ?? APP_OWNERSHIP_CHANNEL);
                let handingOver = false;
                channel.onmessage = (event: MessageEvent) => {
                    // A tab that finds the lock free still asks for it, it must not hand over to itself
                    if (event.data?.type !== HANDOFF_REQUEST || event.data.requester === id || handingOver) {
                        return;
                    }
                    handingOver = true;
                    // The lock is released when the writers stopped, even if stopping them failed
                    handOver().catch(() => { }).then(release);
                };
                // The lock is free only once this callback returned, the request settles then
                const released = request.then(() => { }, () => { });
                resolve(new AppOwnership(channel, release, released));
                await done;
                channel.close();
            });
            request.catch(reject);
        });
    }

    /// Release the ownership without a handoff, e.g. when the app is unmounted
    public dispose(): void {
        this.channel.onmessage = null;
        this.release();
    }
}
