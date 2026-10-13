const attempts = new Map<string, AbortController>();

/// Startup and settings share one cancellation owner per database. Cleanup is identity-safe.
export function registerConnectionSetup(databaseId: string, controller: AbortController): () => void {
    const previous = attempts.get(databaseId);
    attempts.set(databaseId, controller);
    if (previous !== controller) previous?.abort(new DOMException('Connection setup replaced', 'AbortError'));
    return () => {
        if (attempts.get(databaseId) === controller) attempts.delete(databaseId);
    };
}

export function cancelConnectionSetup(databaseId: string): void {
    const controller = attempts.get(databaseId);
    attempts.delete(databaseId);
    controller?.abort(new DOMException('Connection setup cancelled', 'AbortError'));
}
