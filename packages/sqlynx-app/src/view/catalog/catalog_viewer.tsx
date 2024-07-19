import * as React from 'react';

import { CatalogRenderingSettings, CatalogRenderingState } from './catalog_renderer.js';
import { CatalogSnapshotReader } from '../../connectors/catalog_snapshot.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import { useConnectionState } from 'connectors/connection_registry.js';

const RENDERING_SETTINGS: CatalogRenderingSettings = {
    databases: {
        nodeWidth: 320,
        nodeHeight: 48,
        maxUnpinnedChildren: 3,
        rowGap: 8,
        columnGap: 8,
    },
    schemas: {
        nodeWidth: 320,
        nodeHeight: 48,
        maxUnpinnedChildren: 3,
        rowGap: 8,
        columnGap: 8,
    },
    tables: {
        nodeWidth: 320,
        nodeHeight: 48,
        maxUnpinnedChildren: 3,
        rowGap: 8,
        columnGap: 8,
    },
    columns: {
        nodeWidth: 320,
        nodeHeight: 48,
        maxUnpinnedChildren: 3,
        rowGap: 8,
        columnGap: 8,
    },
};

interface Props {
    catalog: CatalogSnapshotReader;
}

export function CatalogViewer(props: Props) {
    const [sessionState, dispatchSession] = useCurrentSessionState();
    const [connState, dispatchConn] = useConnectionState(sessionState?.connectionId ?? null);

    // const state = React.useRef<CatalogRenderingState | null>(null);
    // React.useEffect(() => {
    //     state.current = new CatalogRenderingState(props.catalog, RENDERING_SETTINGS);
    // }, [props.catalog.catalogReader.catalogVersion()]);

    return <div />;
}
