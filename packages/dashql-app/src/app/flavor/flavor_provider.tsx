import * as React from 'react';
import symbols from '@ankoh/dashql-svg-symbols';
import { useLocation } from 'react-router-dom';

import { AppFlavor, DASHQL_FLAVOR } from './flavors.js';
import { withFlavorParameter } from './flavor_resolution.js';

const FLAVOR_CTX = React.createContext<AppFlavor>(DASHQL_FLAVOR);

type Props = {
    /// The flavor of the app
    flavor: AppFlavor;
    /// The children
    children: React.ReactElement;
};

/// Provides the flavor of the app
export const FlavorProvider: React.FC<Props> = (props: Props) => (
    <FLAVOR_CTX.Provider value={props.flavor}>{props.children}</FLAVOR_CTX.Provider>
);

export const useAppFlavor = (): AppFlavor => React.useContext(FLAVOR_CTX);

/// Keeps the flavor query parameter in the url when the router navigates, so that reloads keep the flavor.
/// With the hash router, the routes live in the hash and the query parameter is never dropped.
export function FlavorUrlKeeper() {
    const flavor = useAppFlavor();
    const location = useLocation();
    React.useLayoutEffect(() => {
        const next = withFlavorParameter(new URL(globalThis.location.href), flavor);
        if (next != null) {
            // Replace the url without the router, the history state still holds the router state
            globalThis.history.replaceState(globalThis.history.state, '', next);
        }
    }, [flavor, location]);
    return null;
}

/// The logo of the app flavor, sized by either its height or its width
export function FlavorLogo(props: { height?: number; width?: number; ariaHidden?: boolean }) {
    const logo = useAppFlavor().logo;
    const height = props.height ?? (props.width ?? 0) / logo.aspectRatio;
    const width = props.width ?? height * logo.aspectRatio;
    return (
        <svg width={`${width}px`} height={`${height}px`} aria-hidden={props.ariaHidden}>
            <use xlinkHref={`${symbols}#${logo.symbol}`} />
        </svg>
    );
}
