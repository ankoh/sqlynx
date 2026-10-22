export interface BundledSession {
    id: string;
    name: string;
    sessionId: string;
    manifestPath: `/static/examples/sessions/${string}/dashql-session.json`;
}

export const BUNDLED_SESSIONS = [
    { id: 'demo', name: 'Demo', sessionId: '92a09cb7-5f7d-4f8e-8c78-0dc39d8fff36', manifestPath: '/static/examples/sessions/demo/dashql-session.json' },
    { id: 'hyper-explain', name: 'Explain', sessionId: '8203c46f-e9bd-4940-acc3-decc5d9d13a3', manifestPath: '/static/examples/sessions/hyper-explain/dashql-session.json' },
    { id: 'hyper-property-graphs', name: 'Property Graphs', sessionId: 'f52ad067-c479-4c03-a07a-8edb0cb79711', manifestPath: '/static/examples/sessions/hyper-property-graphs/dashql-session.json' },
    { id: 'dc-calculated-insights', name: 'Calculated Insights', sessionId: '8e63246c-9ab9-4c9c-aa7a-f268adf3fe7b', manifestPath: '/static/examples/sessions/dc-calculated-insights/dashql-session.json' },
    { id: 'dc-transforms', name: 'Transforms', sessionId: '07b766f9-cb22-418e-bf94-42d1ecd9b775', manifestPath: '/static/examples/sessions/dc-transforms/dashql-session.json' },
    { id: 'tpc-h', name: 'TPC-H', sessionId: 'de246c14-208b-4493-a3c3-89c7c6aba032', manifestPath: '/static/examples/sessions/tpch/dashql-session.json' },
] as const satisfies readonly BundledSession[];

export function resolveBundledSessionUrl(session: BundledSession, baseUrl: URL): URL {
    return new URL(session.manifestPath, baseUrl);
}

export function bundledSessionShareUrl(session: BundledSession): string {
    const manifestUrl = resolveBundledSessionUrl(session, new URL('https://dashql.app'));
    return `https://dashql.app?session=${encodeURIComponent(manifestUrl.toString())}`;
}
