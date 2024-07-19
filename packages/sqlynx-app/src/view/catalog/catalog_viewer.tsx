import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';

import { CatalogRenderingSettings, CatalogRenderingState } from './catalog_renderer.js';
import { CatalogSnapshot } from '../../connectors/catalog_snapshot.js';
import { useCurrentSessionState } from '../../session/current_session.js';

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
}

export function CatalogViewer(props: Props) {
    const [sessionState, dispatchSession] = useCurrentSessionState();

    // Maintain a catalog snapshot of the session
    const [snapshot, setSnapshot] = React.useState<null | CatalogSnapshot>(null);
    React.useEffect(() => {
        const newSnapshot = sessionState?.connectionCatalog.createSnapshot() ?? null;
        setSnapshot(newSnapshot);
    }, [sessionState?.connectionCatalog.snapshot]);

    // Create a rendering state
    React.useEffect(() => {
        if (snapshot == null) {
            return;
        }
        const snapshotReader = snapshot.read();
        const _renderingState = new CatalogRenderingState(snapshotReader, RENDERING_SETTINGS);
    }, [snapshot]);

    // const state = React.useRef<CatalogRenderingState | null>(null);
    // React.useEffect(() => {
    //     state.current = new CatalogRenderingState(props.catalog, RENDERING_SETTINGS);
    // }, [props.catalog.catalogReader.catalogVersion()]);

    return <div />;
}
