import * as arrow from 'apache-arrow';
import type { Spec as VegaSpec } from 'vega';
import type { TopLevelSpec } from 'vega-lite';

const SOURCE_DATASET_BASE = '__dashql_source';
const MASK_DATASET_BASE = '__dashql_crossfilter_ids';
const MASK_ACTIVE_BASE = '__dashql_crossfilter_active';
const MASK_SELECTED_FIELD_BASE = '__dashql_crossfilter_selected';
const STABLE_DOMAIN_SIGNAL_BASE = '__dashql_stable_domain';

export const MASK_ROW_ID_FIELD = '__dashql_row_id';

export interface VegaLiteCrossFilterBinding {
    spec: TopLevelSpec;
    sourceDatasetName: string;
    maskDatasetName: string | null;
    maskActiveSignalName: string | null;
    maskSelectedFieldName: string | null;
}

export interface VegaCrossFilterView {
    data(name: string, values: object[]): VegaCrossFilterView;
    signal(name: string, value: unknown): VegaCrossFilterView;
    scale(name: string): { domain(): unknown[] };
    runAsync(): Promise<unknown>;
}

export interface VegaStableScaleDomain {
    scaleName: string;
    signalName: string;
}

export interface VegaStableScaleBinding {
    spec: VegaSpec;
    domains: VegaStableScaleDomain[];
}

export interface VegaCrossFilterMask {
    active: boolean;
    rows: VegaCrossFilterRow[];
}

export interface VegaCrossFilterRow {
    [MASK_ROW_ID_FIELD]: number;
    [key: string]: number | boolean;
}

function allocateName(base: string, usedNames: Set<string>): string {
    let name = base;
    let suffix = 2;
    while (usedNames.has(name)) {
        name = `${base}_${suffix++}`;
    }
    usedNames.add(name);
    return name;
}

function collectRuntimeNames(value: unknown, names: Set<string>): void {
    if (Array.isArray(value)) {
        for (const entry of value) {
            collectRuntimeNames(entry, names);
        }
        return;
    }
    if (value == null || typeof value !== 'object') {
        return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.name === 'string') {
        names.add(object.name);
    }
    for (const entry of Object.values(object)) {
        collectRuntimeNames(entry, names);
    }
}

function hasDataReference(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.some(hasDataReference);
    }
    if (value == null || typeof value !== 'object') {
        return false;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.data === 'string') {
        return true;
    }
    return Object.values(object).some(hasDataReference);
}

/// Override compiled, data-driven Vega scale domains through initially-null signals.
/// The updater fills these signals after evaluating the complete source once, so later
/// cross-filter pulses can recompute marks without changing axes or categorical mappings.
export function injectVegaStableScaleDomains(spec: VegaSpec): VegaStableScaleBinding {
    const input = spec as VegaSpec & {
        scales?: Array<Record<string, unknown>>;
        signals?: Array<Record<string, unknown>>;
    };
    const usedNames = new Set<string>();
    collectRuntimeNames(input, usedNames);
    const domains: VegaStableScaleDomain[] = [];
    const signals = [...(input.signals ?? [])];
    const scales = (input.scales ?? []).map(scale => {
        const scaleName = scale.name;
        if (typeof scaleName !== 'string' || scale.domainRaw != null || !hasDataReference(scale.domain)) {
            return scale;
        }
        const signalName = allocateName(STABLE_DOMAIN_SIGNAL_BASE, usedNames);
        domains.push({ scaleName, signalName });
        signals.push({ name: signalName, value: null });
        return {
            ...scale,
            domainRaw: { signal: signalName },
        };
    });

    if (domains.length === 0) {
        return { spec, domains };
    }
    return {
        spec: {
            ...input,
            scales,
            signals,
        },
        domains,
    };
}

/// Add the renderer-owned row-id relation and membership lookup/filter to a runtime copy
/// of a Vega-Lite spec. Both are prepended so authored transforms only see selected rows.
export function injectVegaLiteCrossFilter(
    spec: TopLevelSpec,
    rowNumberFieldName: string | null,
    sourceFieldNames: Iterable<string> = [],
): VegaLiteCrossFilterBinding {
    const input = spec as TopLevelSpec & {
        datasets?: Record<string, unknown>;
        params?: Array<{ name?: string }>;
        transform?: unknown[];
    };
    const usedNames = new Set<string>(Object.keys(input.datasets ?? {}));
    collectRuntimeNames(input, usedNames);
    for (const fieldName of sourceFieldNames) {
        usedNames.add(fieldName);
    }
    for (const param of input.params ?? []) {
        if (param.name != null) {
            usedNames.add(param.name);
        }
    }

    const sourceDatasetName = allocateName(SOURCE_DATASET_BASE, usedNames);
    const maskDatasetName = rowNumberFieldName != null ? allocateName(MASK_DATASET_BASE, usedNames) : null;
    const maskActiveSignalName = rowNumberFieldName != null ? allocateName(MASK_ACTIVE_BASE, usedNames) : null;
    const maskSelectedFieldName = rowNumberFieldName != null ? allocateName(MASK_SELECTED_FIELD_BASE, usedNames) : null;
    const datasets = { ...(input.datasets ?? {}) };
    const params = [...(input.params ?? [])];
    const transforms = [...(input.transform ?? [])];

    if (rowNumberFieldName != null && maskDatasetName != null && maskActiveSignalName != null && maskSelectedFieldName != null) {
        datasets[maskDatasetName] = [];
        params.push({ name: maskActiveSignalName, value: false });
        transforms.unshift(
            {
                lookup: rowNumberFieldName,
                from: {
                    data: { name: maskDatasetName },
                    key: MASK_ROW_ID_FIELD,
                    fields: [maskSelectedFieldName],
                },
                as: [maskSelectedFieldName],
                default: false,
            },
            {
                filter: `!${maskActiveSignalName} || datum[${JSON.stringify(maskSelectedFieldName)}] === true`,
            },
        );
    }
    const augmented = {
        ...input,
        data: { name: sourceDatasetName },
        datasets,
        params,
        transform: transforms,
    } as unknown as TopLevelSpec;

    return {
        spec: augmented,
        sourceDatasetName,
        maskDatasetName,
        maskActiveSignalName,
        maskSelectedFieldName,
    };
}

/// Convert the one-column DashQL filter table to the small relation consumed by the lookup.
export function filterTableToVegaCrossFilterRows(table: arrow.Table, selectedFieldName: string): VegaCrossFilterRow[] {
    if (table.numCols !== 1) {
        return [];
    }
    const column = table.getChildAt(0);
    if (column == null) {
        return [];
    }
    const rows: VegaCrossFilterRow[] = [];
    for (let i = 0; i < column.length; ++i) {
        const value = column.get(i);
        if (value == null) {
            continue;
        }
        rows.push({
            [MASK_ROW_ID_FIELD]: Number(value),
            [selectedFieldName]: true,
        });
    }
    return rows;
}

/// Serialize Vega runs and collapse rapid brush results to the newest pending mask.
export class VegaCrossFilterUpdater {
    private view: VegaCrossFilterView | null;
    private sourceRows: object[] | null;
    private readonly sourceDatasetName: string;
    private readonly maskDatasetName: string | null;
    private readonly maskActiveSignalName: string | null;
    private readonly stableScaleDomains: readonly VegaStableScaleDomain[];
    private pending: VegaCrossFilterMask | null = null;
    private running = false;
    private readonly onError: (error: unknown) => void;

    constructor(
        view: VegaCrossFilterView,
        sourceDatasetName: string,
        sourceRows: object[],
        maskDatasetName: string | null,
        maskActiveSignalName: string | null,
        onError: (error: unknown) => void = () => { },
        stableScaleDomains: readonly VegaStableScaleDomain[] = [],
    ) {
        this.view = view;
        this.sourceDatasetName = sourceDatasetName;
        this.sourceRows = sourceRows;
        this.maskDatasetName = maskDatasetName;
        this.maskActiveSignalName = maskActiveSignalName;
        this.onError = onError;
        this.stableScaleDomains = stableScaleDomains;
    }

    update(mask: VegaCrossFilterMask): void {
        if (this.view == null) {
            return;
        }
        this.pending = mask;
        if (!this.running) {
            void this.flush();
        }
    }

    dispose(): void {
        this.view = null;
        this.sourceRows = null;
        this.pending = null;
    }

    private async flush(): Promise<void> {
        this.running = true;
        try {
            while (this.view != null && this.pending != null) {
                const view = this.view;
                if (this.sourceRows != null) {
                    view.data(this.sourceDatasetName, this.sourceRows);
                    this.sourceRows = null;
                    if (this.stableScaleDomains.length > 0) {
                        if (this.maskDatasetName != null && this.maskActiveSignalName != null) {
                            view
                                .data(this.maskDatasetName, [])
                                .signal(this.maskActiveSignalName, false);
                        }
                        await view.runAsync();
                        if (this.view !== view) {
                            continue;
                        }
                        for (const domain of this.stableScaleDomains) {
                            view.signal(domain.signalName, [...view.scale(domain.scaleName).domain()]);
                        }
                    }
                }
                const mask = this.pending;
                if (mask == null) {
                    continue;
                }
                this.pending = null;
                if (this.maskDatasetName != null && this.maskActiveSignalName != null) {
                    view
                        .data(this.maskDatasetName, mask.rows)
                        .signal(this.maskActiveSignalName, mask.active);
                }
                await view.runAsync();
            }
        } catch (error: unknown) {
            this.onError(error);
        } finally {
            this.running = false;
            if (this.view != null && this.pending != null) {
                void this.flush();
            }
        }
    }
}
