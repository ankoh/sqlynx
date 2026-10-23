import * as React from 'react';
import * as arrow from 'apache-arrow';
import type { TopLevelSpec } from 'vega-lite';

import * as styles from './visualization.module.css';
import { QueryExecutionState, QueryExecutionStatus } from '../../../../../query/query_execution_state.js';
import { useComputationRegistry } from '../../../../../compute/computation_registry.js';
import {
    filterTableToVegaCrossFilterRows,
    injectVegaStableScaleDomains,
    injectVegaLiteCrossFilter,
    VegaCrossFilterMask,
    VegaCrossFilterUpdater,
    VegaStableScaleDomain,
} from './vegalite_crossfilter.js';

type VegaEmbed = typeof import('vega-embed').default;
type VegaExpressionInterpreter = typeof import('vega-interpreter').expressionInterpreter;

export interface VegaLiteViewDependencies {
    loadVega(): Promise<{
        embed: VegaEmbed;
        expressionInterpreter: VegaExpressionInterpreter;
    }>;
    useComputationRegistry(): [ReturnType<typeof useComputationRegistry>[0]];
}

const DEFAULT_DEPENDENCIES: VegaLiteViewDependencies = {
    async loadVega() {
        const [embed, interpreter] = await Promise.all([import('vega-embed'), import('vega-interpreter')]);
        return {
            embed: embed.default,
            expressionInterpreter: interpreter.expressionInterpreter,
        };
    },
    useComputationRegistry: () => {
        const [state] = useComputationRegistry();
        return [state];
    },
};

interface Props {
    query: QueryExecutionState | null;
    vegaLiteSpec: TopLevelSpec | null;
    /// Optional exact width/height in px for the whole chart. The view is sized to `fit`, so the
    /// entire plot (marks, axes, legend) fits the available box. An unset dimension falls back to
    /// the container.
    width?: number;
    height?: number;
    /// Optional uniform scale factor (<1 shrinks). `fit` only rescales the plot *area*; label fonts,
    /// mark sizes and stroke widths keep their absolute px, so on a tiny box they look oversized.
    /// This renders the chart into a `1/scale` larger logical box and CSS-scales the result down, so
    /// *everything* — text, marks, axes — shrinks uniformly while still landing in the width×height
    /// box. Defaults to 1 (no scaling).
    scale?: number;
    /// Suppress all legends. Legends eat a lot of space in a cramped host (e.g. a grid card
    /// thumbnail), so the compact rendering strips them by injecting `legend: null` into every
    /// encoding channel. Defaults to false (legends shown as authored).
    hideLegend?: boolean;
    dependencies?: VegaLiteViewDependencies;
}

/// The encoding channels that can produce a legend in Vega-Lite. Setting `legend: null` on any of
/// these suppresses its legend.
const LEGEND_CHANNELS = ['color', 'fill', 'stroke', 'size', 'shape', 'opacity', 'strokeWidth', 'strokeDash', 'angle'];

/// Recursively strip legends from a Vega-Lite spec by setting `legend: null` on every legend-bearing
/// encoding channel. Walks nested specs (layer / hconcat / vconcat / concat / facet / spec) so
/// composed views are covered too. Returns a deep-ish copy with the mutations applied; the input is
/// left untouched.
function stripLegends<T>(spec: T): T {
    if (Array.isArray(spec)) {
        return spec.map(stripLegends) as unknown as T;
    }
    if (spec == null || typeof spec !== 'object') {
        return spec;
    }
    const out: Record<string, unknown> = { ...(spec as Record<string, unknown>) };
    if (out.encoding != null && typeof out.encoding === 'object') {
        const encoding: Record<string, unknown> = { ...(out.encoding as Record<string, unknown>) };
        for (const channel of LEGEND_CHANNELS) {
            const def = encoding[channel];
            if (def != null && typeof def === 'object' && !Array.isArray(def)) {
                encoding[channel] = { ...(def as Record<string, unknown>), legend: null };
            }
        }
        out.encoding = encoding;
    }
    for (const key of ['layer', 'hconcat', 'vconcat', 'concat', 'spec']) {
        if (out[key] != null && typeof out[key] === 'object') {
            out[key] = stripLegends(out[key]);
        }
    }
    return out as unknown as T;
}

/// Convert an arrow row object to a vega-compatible plain object.
function arrowRowToObject(row: any, fields: readonly arrow.Field[]): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const field of fields) {
        const value = row[field.name];
        // Convert BigInts to numbers for vega compatibility
        if (typeof value === 'bigint') {
            obj[field.name] = Number(value);
        } else if (value instanceof Date) {
            obj[field.name] = value.toISOString();
        } else {
            obj[field.name] = value;
        }
    }
    return obj;
}

function arrowTableToRows(table: arrow.Table): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    for (const row of table) {
        rows.push(arrowRowToObject(row, table.schema.fields));
    }
    return rows;
}

/// Structural signatures of specs, computed once per spec object
const specSignatures = new WeakMap<object, string>();

function getSpecSignature(spec: object): string {
    let signature = specSignatures.get(spec);
    if (signature === undefined) {
        signature = JSON.stringify(spec);
        specSignatures.set(spec, signature);
    }
    return signature;
}

export function VegaLiteView(props: Props): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const crossFilterUpdaterRef = React.useRef<VegaCrossFilterUpdater | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const [computationState] = dependencies.useComputationRegistry();

    const succeeded = props.query?.status === QueryExecutionStatus.SUCCEEDED;
    // Analysis emits a fresh spec object for editor transactions, including cursor-only updates.
    // Keep the previous identity when the authored spec is structurally unchanged so Vega's
    // effect does not finalize and rebuild the canvas while the user types or moves the cursor.
    const specSignature = props.vegaLiteSpec == null ? null : getSpecSignature(props.vegaLiteSpec);
    const spec = React.useMemo(() => props.vegaLiteSpec, [specSignature]);
    const queryId = props.query?.queryId ?? null;

    // Prefer the analyzed data table (it carries the cross-filter row-id indirection); fall back
    // to the raw result table when there is no computation registered. The analyzed table is a
    // superset of the result columns (system / umap columns are ignored by the spec).
    const tableComputation = queryId != null ? computationState.tableComputations[queryId] ?? null : null;
    const dataTable = tableComputation?.dataTable ?? (succeeded ? props.query?.resultTable ?? null : null);
    const rowNumberColumnName = tableComputation?.rowNumberColumnName ?? null;

    const filterTable = tableComputation?.filterTable ?? null;
    const rows = React.useMemo<Record<string, unknown>[] | null>(() => {
        if (!succeeded || !dataTable) return null;
        return arrowTableToRows(dataTable);
    }, [succeeded, dataTable]);
    const crossFilterBinding = React.useMemo(() => {
        if (spec == null || dataTable == null) {
            return null;
        }
        const baseSpec = props.hideLegend ? stripLegends(spec) : spec;
        return injectVegaLiteCrossFilter(
            baseSpec,
            rowNumberColumnName,
            dataTable.schema.fields.map(field => field.name),
        );
    }, [spec, rowNumberColumnName, dataTable, props.hideLegend]);
    const maskSelectedFieldName = crossFilterBinding?.maskSelectedFieldName ?? null;
    const crossFilterMask = React.useMemo<VegaCrossFilterMask>(() => ({
        active: filterTable != null,
        rows: filterTable != null && maskSelectedFieldName != null
            ? filterTableToVegaCrossFilterRows(filterTable.dataTable, maskSelectedFieldName)
            : [],
    }), [filterTable, maskSelectedFieldName]);
    const crossFilterMaskRef = React.useRef(crossFilterMask);
    crossFilterMaskRef.current = crossFilterMask;

    React.useEffect(() => {
        crossFilterUpdaterRef.current?.update(crossFilterMask);
    }, [crossFilterMask]);

    // A uniform scale (<1) is applied via CSS transform on the chart container. To still land in the
    // requested width×height box, the chart is laid out into a `1/scale` larger logical box so that
    // scaling it back down recovers the exact size — but with fonts/marks/strokes visually smaller.
    const scale = props.scale != null && props.scale > 0 ? props.scale : 1;
    const width = props.width != null ? Math.round(props.width / scale) : null;
    const height = props.height != null ? Math.round(props.height / scale) : null;
    React.useEffect(() => {
        const el = containerRef.current;
        if (!el || !spec || !rows) return;

        let disposed = false;
        let finalizeView: (() => void) | null = null;
        let stableScaleDomains: VegaStableScaleDomain[] = [];
        const baseSpec = crossFilterBinding?.spec ?? (props.hideLegend ? stripLegends(spec) : spec);
        const runtimeSpec = { ...baseSpec } as TopLevelSpec & {
            width?: unknown;
            height?: unknown;
            autosize?: unknown;
        };
        // Pin whichever exact dimensions were requested; otherwise fill the container.
        runtimeSpec.width = width != null ? width : 'container';
        runtimeSpec.height = height != null ? height : 'container';
        // Include axes, legends and titles in the available size, and recalculate their bounds when
        // data or the container changes instead of relying on fixed outer padding.
        runtimeSpec.autosize = { type: 'fit', contains: 'padding', resize: true };
        // Lazy-load vega-embed (and vega-interpreter, which avoids the
        // CSP-violating `Function()` eval that vega's default expression
        // compiler does) to keep them out of the import graph for non-vis paths.
        dependencies.loadVega().then(({ embed, expressionInterpreter }) => {
            if (disposed) return;
            // `ast: true` makes vega parse expressions to an AST and gates the
            // `expr` option on, so vega-interpreter actually replaces the
            // default `new Function()` evaluator (which CSP forbids).
            return embed(el, runtimeSpec, {
                actions: false,
                renderer: 'canvas',
                ast: true,
                expr: expressionInterpreter,
                patch: compiledSpec => {
                    const stableScales = injectVegaStableScaleDomains(compiledSpec);
                    stableScaleDomains = stableScales.domains;
                    return stableScales.spec;
                },
                // `mark.tooltip: true` makes Vega-Lite derive a tooltip from each mark's encoded
                // fields; vega-embed installs the vega-tooltip handler by default, so hovering a
                // mark shows its data. Applied via config so it covers every mark without editing
                // the generated spec.
                config: { background: 'transparent', mark: { tooltip: true } },
            });
        }).then(result => {
            if (!result) return;
            if (disposed) {
                result.view.finalize();
                return;
            }
            finalizeView = () => result.view.finalize();
            if (crossFilterBinding != null) {
                const updater = new VegaCrossFilterUpdater(
                    result.view,
                    crossFilterBinding.sourceDatasetName,
                    rows,
                    crossFilterBinding.maskDatasetName,
                    crossFilterBinding.maskActiveSignalName,
                    e => setError(e instanceof Error ? e.message : String(e)),
                    stableScaleDomains,
                );
                crossFilterUpdaterRef.current = updater;
                updater.update(crossFilterMaskRef.current);
            }
            setError(null);
        }).catch((e: unknown) => {
            setError(e instanceof Error ? e.message : String(e));
        });
        return () => {
            disposed = true;
            crossFilterUpdaterRef.current?.dispose();
            crossFilterUpdaterRef.current = null;
            finalizeView?.();
            if (el) el.replaceChildren();
        };
    }, [spec, rows, crossFilterBinding, width, height, scale, props.hideLegend, dependencies]);

    if (!spec) {
        return <div className={styles.empty}>No visualization available</div>;
    }
    if (!succeeded) {
        return <div className={styles.empty}>Run the query to see the visualization</div>;
    }
    if (!dataTable) {
        return <div className={styles.empty}>Result is empty</div>;
    }

    // When scaling, the chart container is laid out at the enlarged logical size and shrunk with a
    // CSS transform anchored top-left, so the whole plot renders smaller within the requested box.
    // Reserve explicit dimensions before the async vega-embed import finishes. This is important in
    // the virtualized feed: a remounted chart otherwise collapses temporarily, causing its row's
    // ResizeObserver to publish a smaller height before the canvas restores the final height.
    const chartStyle: React.CSSProperties | undefined = width != null || height != null || scale !== 1
        ? {
            width: width ?? undefined,
            height: height ?? undefined,
            transform: scale !== 1 ? `scale(${scale})` : undefined,
            transformOrigin: scale !== 1 ? 'top left' : undefined,
        }
        : undefined;

    return (
        <div className={styles.root}>
            {error && <div className={styles.error}>{error}</div>}
            <div ref={containerRef} className={styles.chart} style={chartStyle} />
        </div>
    );
}
