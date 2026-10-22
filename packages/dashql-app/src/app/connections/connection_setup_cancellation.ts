const attempts = new Map<string, AbortController>();

/// Startup and settings share one cancellation owner per database. Cleanup is identity-safe.
export function registerConnectionSetup(connectionId: string, controller: AbortController): () => void {
    const previous = attempts.get(connectionId);
    attempts.set(connectionId, controller);
    if (previous !== controller) previous?.abort(new DOMException('Connection setup replaced', 'AbortError'));
    return () => {
        if (attempts.get(connectionId) === controller) attempts.delete(connectionId);
    };
}

export function cancelConnectionSetup(connectionId: string): void {
    const controller = attempts.get(connectionId);
    attempts.delete(connectionId);
    controller?.abort(new DOMException('Connection setup cancelled', 'AbortError'));
}
