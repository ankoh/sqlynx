import type { AppSettings } from '../config/app_config.js';

/// A product flavor of the app: brand identity, theme tokens and settings defaults.
/// The theme tokens live in `src/styles/flavors/<id>.css`, scoped to `:root[data-flavor="<id>"]`.
export interface AppFlavor {
    /// The flavor id, used in `?flavor=<id>` and as the `data-flavor` attribute
    id: string;
    /// The product name shown in the UI and the document title
    displayName: string;
    /// The id of the logo symbol in the svg sprite
    logoSymbol: string;
    /// The favicon replacing the static favicons of the html entry pages, null keeps them
    favicon: URL | null;
    /// Settings layered over the settings of config.json, persisted user settings still win
    settings?: AppSettings;
}

/// The default flavor, the static html entry pages are branded for it
export const DASHQL_FLAVOR: AppFlavor = {
    id: 'dashql',
    displayName: 'DashQL',
    logoSymbol: 'dashql',
    favicon: null,
};

/// The sidb flavor
export const SIDB_FLAVOR: AppFlavor = {
    id: 'sidb',
    displayName: 'sidb',
    logoSymbol: 'sidb',
    favicon: new URL('../../../static/favicons/sidb/favicon.svg?no-inline', import.meta.url),
};

/// All flavors by id
export const FLAVORS: Map<string, AppFlavor> = new Map([DASHQL_FLAVOR, SIDB_FLAVOR].map(f => [f.id, f]));

/// Layer the settings of a flavor over the settings of the app config
export function applyFlavorSettings(settings: AppSettings | undefined, flavor: AppFlavor): AppSettings | undefined {
    if (flavor.settings == null) {
        return settings;
    }
    return { ...(settings ?? {}), ...flavor.settings };
}
