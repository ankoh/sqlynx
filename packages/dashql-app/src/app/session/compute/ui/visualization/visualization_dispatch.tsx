import * as React from 'react';

import { QueryExecutionState } from '../../../connections/query_execution_state.js';
import { ResolvedVisualizeQuery } from '../../../scripts/script_types.js';
import { VegaLiteView } from './vegalite_view.js';
import { UmapView } from './umap/umap_view.js';
import { MarkdownView } from './markdown_view.js';
import { QueryResultView } from '../query_result/query_result_view.js';
import { TableColumnHeader } from '../query_result/data_table_cell.js';

interface Props {
    query: QueryExecutionState | null;
    visualizeQuery: ResolvedVisualizeQuery | null;
    /// Render the umap scatter with a transparent background (feed footer preview).
    transparent?: boolean;
    /// Enable pan/drag on renderers that support it. Defaults to true.
    interactive?: boolean;
    /// Enable scroll-wheel zoom. Disabled in the feed footer so the wheel scrolls the feed
    /// instead of being captured by the chart. Defaults to true.
    wheelZoom?: boolean;
    /// Optional exact chart width/height in px. Currently honored by the Vega-Lite renderer (sizes
    /// the whole plot to `fit`); the umap scatter already fills its container.
    width?: number;
    height?: number;
    /// Optional uniform scale (<1 shrinks fonts/marks/axes). Honored by the Vega-Lite renderer.
    scale?: number;
    /// Suppress legends (they crowd out a cramped host like a grid card). Honored by the Vega-Lite
    /// renderer.
    hideLegend?: boolean;
}

/// Renders the visualization for a resolved VISUALIZE query, dispatching on the
/// renderer named after `USING`. Vega-Lite goes to the vega-embed VegaLiteView;
/// umap goes to the WebGPU/WebGL2 scatter UmapView.
export function VisualizationDispatch(props: Props): React.ReactElement | null {
    const vq = props.visualizeQuery;
    if (vq == null) {
        return <VegaLiteView query={props.query} vegaLiteSpec={null} />;
    }
    switch (vq.renderer) {
        case 'umap':
            return (
                <UmapView
                    query={props.query}
                    spec={vq.umapSpec}
                    transparent={props.transparent}
                    interactive={props.interactive}
                    wheelZoom={props.wheelZoom}
                />
            );
        case 'vegalite':
            return <VegaLiteView query={props.query} vegaLiteSpec={vq.vegaLiteSpec} width={props.width} height={props.height} scale={props.scale} hideLegend={props.hideLegend} />;
        case 'markdown':
            return <MarkdownView query={props.query} spec={vq.markdownSpec} />;
        case 'table':
            return (
                <QueryResultView
                    query={props.query}
                    debugMode={false}
                    columnHeader={TableColumnHeader.OnlyColumnName}
                    fitHeight={false}
                    compact
                />
            );
    }
}
