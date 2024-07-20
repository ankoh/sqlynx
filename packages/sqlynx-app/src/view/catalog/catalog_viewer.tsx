import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';
import * as styles from './catalog_viewer.module.css'

import { CatalogRenderingSettings, CatalogRenderingState, layoutCatalog, renderCatalog } from './catalog_renderer.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import { observeSize } from '../foundations/size_observer.js';

const RENDERING_SETTINGS: CatalogRenderingSettings = {
    databases: {
        nodeWidth: 120,
        nodeHeight: 24,
        maxUnpinnedChildren: 3,
        rowGap: 8,
        columnGap: 8,
    },
    schemas: {
        nodeWidth: 120,
        nodeHeight: 24,
        maxUnpinnedChildren: 3,
        rowGap: 8,
        columnGap: 8,
    },
    tables: {
        nodeWidth: 120,
        nodeHeight: 24,
        maxUnpinnedChildren: 3,
        rowGap: 8,
        columnGap: 8,
    },
    columns: {
        nodeWidth: 120,
        nodeHeight: 24,
        maxUnpinnedChildren: 3,
        rowGap: 8,
        columnGap: 8,
    },
};

interface Props {
}

export function CatalogViewer(props: Props) {
    const [sessionState, _dispatchSession] = useCurrentSessionState();

    // Maintain a catalog snapshot of the session
    const [state, setState] = React.useState<CatalogRenderingState | null>(null);
    React.useEffect(() => {
        const snapshot = sessionState?.connectionCatalog.createSnapshot() ?? null;
        if (snapshot) {
            const state = new CatalogRenderingState(snapshot, RENDERING_SETTINGS);
            setState(state);
        }
    }, [sessionState?.connectionCatalog.snapshot]);


    // Watch the container size
    const containerElement = React.useRef(null);
    const containerSize = observeSize(containerElement);

    // Memo must depend on scroll window and window size
    const nodes = React.useMemo(() => {
        // No state or measured container size?
        if (!state || !containerSize) {
            return null;
        }
        // Update the virtual window
        const windowBegin = 0;
        const windowEnd = containerSize.height;
        state.updateVirtualWindow(windowBegin, windowEnd);
        // Render the catalog
        return renderCatalog(state);

    }, [state, containerSize?.height]);

    return (
        <div className={styles.root}>
            <div className={styles.board_container} ref={containerElement}>
                <div className={styles.board_container} ref={containerElement}>
                    <div
                        className={styles.node_layer}
                        style={{
                            width: state?.totalWidth,
                            height: state?.totalHeight,
                        }}
                    >
                        {nodes}
                    </div>
                </div>
            </div>
            <div className={styles.overlay_title}>Schema</div>
        </div>
    );
}
