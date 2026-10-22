import { AppFlavor, DASHQL_FLAVOR, FLAVORS } from './flavors.js';

/// The query parameter selecting a flavor, e.g. `?flavor=sidb`
export const FLAVOR_QUERY_PARAMETER = 'flavor';

/// The result of resolving the flavor
export interface FlavorResolution {
    /// The resolved flavor
    flavor: AppFlavor;
    /// A requested flavor id that is not known
    unknownId?: string;
}

/// Resolve the flavor from the query parameter, DashQL is the default
export function resolveFlavor(requested: string | null): FlavorResolution {
    if (requested == null) {
        return { flavor: DASHQL_FLAVOR };
    }
    const flavor = FLAVORS.get(requested);
    if (flavor == null) {
        return { flavor: DASHQL_FLAVOR, unknownId: requested };
    }
    return { flavor };
}

let APP_FLAVOR: AppFlavor | null = null;

/// Get the flavor of this page, resolved once from the query parameter
export function getAppFlavor(): AppFlavor {
    if (APP_FLAVOR != null) {
        return APP_FLAVOR;
    }
    const search = new URLSearchParams(globalThis.location?.search ?? '');
    const resolution = resolveFlavor(search.get(FLAVOR_QUERY_PARAMETER));
    if (resolution.unknownId !== undefined) {
        console.warn(`unknown app flavor: ${resolution.unknownId}`);
    }
    APP_FLAVOR = resolution.flavor;
    return APP_FLAVOR;
}

/// The url with the query parameter of a flavor, null if it already carries it.
/// The default flavor needs no query parameter.
export function withFlavorParameter(url: URL, flavor: AppFlavor): URL | null {
    if (flavor.id === DASHQL_FLAVOR.id || url.searchParams.get(FLAVOR_QUERY_PARAMETER) === flavor.id) {
        return null;
    }
    const next = new URL(url);
    next.searchParams.set(FLAVOR_QUERY_PARAMETER, flavor.id);
    return next;
}

/// Brand the document of an html entry page with a flavor.
/// The static entry pages carry the DashQL favicons, they are only replaced for flavors with their own.
export function applyFlavorToDocument(flavor: AppFlavor, doc: Document = document) {
    doc.documentElement.dataset.flavor = flavor.id;
    doc.title = flavor.displayName;
    doc.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', flavor.displayName);
    if (flavor.favicon != null) {
        for (const link of doc.head.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')) {
            link.remove();
        }
        const icon = doc.createElement('link');
        icon.rel = 'icon';
        icon.href = flavor.favicon.href;
        doc.head.appendChild(icon);
    }
}
