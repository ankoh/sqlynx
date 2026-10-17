import type { CompiledVisualization } from './core.js';

const MAX_TEXT_LENGTH = 80;
/// A chart entry is the smallest unit that the token budget can drop (see `renderFeatureDocument`), so one crowded
/// chart must not grow without bound. The chart name and the first items (mark, faceting, x, y, color) say the most.
const MAX_ENTRY_ITEMS = 8;

/// The parts of a Vega-Lite spec that describe what a chart shows. Everything else is ignored:
/// the embedding should capture what a chart is about, not how it is styled (scales, colors, sizes, padding, ...).
/// The spec's `data` member is never read, it only repeats the query that the feature text already covers.
/// This reads the generated JSON and not the DashQL AST, so it describes exactly what the app renders and stays
/// independent of the DashQL grammar.
interface FieldDef {
    field?: string;
    type?: string;
    aggregate?: string;
    timeUnit?: unknown;
    bin?: unknown;
    stack?: unknown;
    sort?: unknown;
    datum?: unknown;
    value?: unknown;
    title?: unknown;
    axis?: { title?: unknown } | null;
    legend?: { title?: unknown } | null;
}

type Encoding = Record<string, FieldDef | undefined>;

interface View {
    mark?: unknown;
    encoding?: Encoding;
    title?: unknown;
    description?: unknown;
    layer?: View[];
    resolve?: Record<string, Record<string, unknown> | undefined>;
}

/// Channels that split a chart into small multiples
const FACET_CHANNELS = ['row', 'column', 'facet'];

/// Vega-Lite titles come as a string, a list of lines or an object with a `text` member
function text(value: unknown): string | null {
    if (typeof value === 'string') return value.length > 0 ? value : null;
    if (Array.isArray(value)) return text(value.filter(v => typeof v === 'string').join(' '));
    if (value && typeof value === 'object') return text((value as { text?: unknown }).text);
    return null;
}

/// Quote user-provided text and cap its length, titles can be arbitrarily long
function quote(value: string): string {
    const flat = value.replace(/\s+/g, ' ').trim();
    return `"${flat.length > MAX_TEXT_LENGTH ? `${flat.slice(0, MAX_TEXT_LENGTH - 3)}...` : flat}"`;
}

function literal(value: unknown): string {
    return typeof value === 'string' ? quote(value) : JSON.stringify(value);
}

interface MarkInfo {
    type: string;
    /// The mark with the options that change how it looks, e.g. `line with points`
    text: string;
}

/// Only options that change what the chart shows are kept: orientation, point and line overlays, interpolation.
/// Colors, sizes, opacity and the like are styling.
function markInfo(mark: unknown): MarkInfo | null {
    const def = typeof mark === 'string' ? { type: mark } : (mark as Record<string, unknown> | null | undefined);
    const type = typeof def?.type === 'string' ? def.type : null;
    if (!def || !type) return null;
    const on = (v: unknown): boolean => v !== undefined && v !== null && v !== false;
    const orient = def.orient === 'horizontal' || def.orient === 'vertical' ? `${def.orient} ` : '';
    const parts = [`${orient}${type}`];
    if (on(def.point)) parts.push('with points');
    if (type === 'area' && on(def.line)) parts.push('with line');
    if (typeof def.interpolate === 'string') parts.push(`${def.interpolate} interpolation`);
    return { type, text: parts.join(' ') };
}

/// Stacking changes the meaning of a chart (absolute values vs. shares), `stack: null` explicitly turns it off
function stackText(stack: unknown): string {
    switch (stack) {
        case 'normalize': return 'normalized stack';
        case 'center': return 'centered stack';
        case false:
        case null: return 'unstacked';
        default: return 'stacked';
    }
}

/// The order of the marks is part of what a chart says ("top 10 products by revenue"). Custom orders are not listed,
/// the values are data and can be long.
function sortText(sort: unknown): string | null {
    if (typeof sort === 'string') return `sort ${sort}`;
    if (Array.isArray(sort)) return 'custom order';
    if (sort && typeof sort === 'object') {
        const s = sort as { field?: string; encoding?: string; op?: string; order?: string };
        const by = s.op ? `${s.op}(${s.field ?? s.encoding ?? ''})` : (s.field ?? s.encoding);
        return ['sort', s.order, by && `by ${by}`].filter(p => !!p).join(' ');
    }
    return null;
}

function timeUnitText(timeUnit: unknown): string | undefined {
    return typeof timeUnit === 'string' ? timeUnit : text((timeUnit as { unit?: unknown } | null)?.unit) ?? undefined;
}

/// `x Year temporal`, `y sum(revenue) quantitative normalized stack`, `size value 100`.
/// Scale, axis and legend settings are left out except for their titles, which are natural language.
/// A channel without a field, constant or aggregate carries no information and is skipped (returns null).
function describeChannel(channel: string, def: FieldDef): string | null {
    const parts: (string | undefined)[] = [channel];
    if (def.field !== undefined || def.aggregate !== undefined) {
        parts.push(def.aggregate ? `${def.aggregate}(${def.field ?? ''})` : def.field);
    } else if (def.datum !== undefined) {
        parts.push('datum', literal(def.datum));
    } else if (def.value !== undefined) {
        parts.push('value', literal(def.value));
    }
    parts.push(timeUnitText(def.timeUnit), def.bin ? 'binned' : undefined, def.type);
    if ('stack' in def) parts.push(stackText(def.stack));
    parts.push(sortText(def.sort) ?? undefined);
    const title = text(def.title) ?? text(def.axis?.title) ?? text(def.legend?.title);
    if (title) parts.push(`titled ${quote(title)}`);
    const out = parts.filter(p => !!p) as string[];
    return out.length > 1 ? out.join(' ') : null;
}

/// A name for what the mark and the encoding make of the data, in the words that people search for.
/// Prompts say "scatter plot" or "histogram", never "point" or "bar with a binned x". The rules are deliberately
/// conservative: when the encoding does not clearly indicate a chart type, there is no name and the entry falls back to
/// the plain mark. A wrong name is worse than a missing one, because it pulls the script towards unrelated prompts.
function chartKind(mark: string | null, enc: Encoding): string | null {
    const used = (ch: string): boolean => {
        const d = enc[ch];
        return !!d && (d.field !== undefined || d.aggregate !== undefined || d.datum !== undefined || d.value !== undefined);
    };
    const quantitative = (ch: string): boolean => enc[ch]?.type === 'quantitative';
    const temporal = (ch: string): boolean => enc[ch]?.type === 'temporal' || !!enc[ch]?.timeUnit;
    const binned = (ch: string): boolean => !!enc[ch]?.bin;
    // An explicit `stack: null` switches stacking off, so look for the key and not for a value
    const stackDef = [enc.y, enc.x, enc.theta].find(d => d && 'stack' in d);
    const stack = stackDef?.stack;
    const stacked = stack !== false && stack !== null;
    // A color that repeats an axis does not split the bars into segments, Vega-Lite draws one segment per bar then into segments
    const split = ['color', 'fill', 'stroke'].some(
        ch => used(ch) && enc[ch]?.field !== undefined && enc[ch]?.field !== enc.x?.field && enc[ch]?.field !== enc.y?.field,
    );
    if ((used('latitude') && used('longitude')) || mark === 'geoshape') return 'map';
    switch (mark) {
        case 'point':
        case 'circle':
        case 'square':
            // Aggregated points are summaries (e.g. dots per category), not a scatter plot
            if (!quantitative('x') || !quantitative('y') || enc.x?.aggregate || enc.y?.aggregate) return null;
            return used('size') && quantitative('size') ? 'bubble chart' : 'scatter plot';
        case 'bar':
            if (binned('x') || binned('y')) return 'histogram';
            if (used('xOffset') || used('yOffset')) return 'grouped bar chart';
            if (split && stacked) return stack === 'normalize' ? 'normalized stacked bar chart' : 'stacked bar chart';
            return 'bar chart';
        case 'line':
            return temporal('x') || temporal('y') ? 'time series line chart' : 'line chart';
        case 'area':
            if (stack === 'normalize') return 'normalized area chart';
            if (split && stacked) return 'stacked area chart';
            return temporal('x') || temporal('y') ? 'time series area chart' : 'area chart';
        case 'rect':
            // A rect needs both axes and a color to be a heatmap, rects are also used for gantt charts and the like
            return used('x') && used('y') && used('color') ? 'heatmap' : null;
        case 'arc':
            return used('theta') ? (used('radius') ? 'radial chart' : 'pie chart') : null;
        case 'tick':
            return 'strip plot';
        case 'boxplot':
            return 'box plot';
        default:
            return null;
    }
}

/// The charts of a spec: itself, or one per layer. Layers inherit the mark and the encoding of their parent and may
/// override single channels, as in Vega-Lite. Every layer is a chart of its own because a layered chart (line + target
/// points) can be neither found nor told apart by its shared axis alone.
function leafViews(view: View, mark: unknown, encoding: Encoding): { mark: unknown; encoding: Encoding }[] {
    const merged = { ...encoding, ...view.encoding };
    const own = view.mark ?? mark;
    if (!Array.isArray(view.layer) || view.layer.length === 0) return [{ mark: own, encoding: merged }];
    return view.layer.flatMap(layer => leafViews(layer, own, merged));
}

/// Scales, axes and legends that layers do not share, e.g. a second y axis. `shared` is the default and not worth a word.
function independentResolves(resolve: View['resolve']): string[] {
    const out: string[] = [];
    for (const [kind, channels] of Object.entries(resolve ?? {})) {
        for (const [channel, mode] of Object.entries(channels ?? {})) {
            if (mode === 'independent') out.push(`independent ${channel} ${kind}`);
        }
    }
    return out;
}

function describeVegaLite(renderer: string, specText: string): string[] {
    let spec: View;
    try {
        spec = JSON.parse(specText) as View;
    } catch {
        return [renderer];
    }
    const leaves = leafViews(spec, undefined, {});
    const title = text(spec.title);
    const description = text(spec.description);
    return leaves.map(({ mark, encoding }, i) => {
        const info = markInfo(mark);
        const kind = chartKind(info?.type ?? null, encoding);
        const head = [renderer];
        if (leaves.length > 1) head.push(`layer ${i + 1} of ${leaves.length}`);
        head.push(kind ?? info?.text ?? '');
        // Titles and resolve rules belong to the whole chart. They are listed once, on the first layer, to save tokens.
        // Layers are cut from the end when the budget is tight, so the first layer is the one that survives.
        if (i === 0 && title) head.push(`titled ${quote(title)}`);
        if (i === 0 && description) head.push(`described ${quote(description)}`);

        const items: string[] = [];
        // The mark is the head of the entry if there is no chart name, otherwise it is listed so that it is not lost
        if (kind && info) items.push(info.text);
        if (FACET_CHANNELS.some(ch => encoding[ch])) items.push('small multiples');
        for (const [channel, def] of Object.entries(encoding)) {
            const described = def && describeChannel(channel, def);
            if (described) items.push(described);
        }
        if (i === 0) items.push(...independentResolves(spec.resolve));
        if (items.length > MAX_ENTRY_ITEMS) {
            const omitted = items.length - MAX_ENTRY_ITEMS;
            items.splice(MAX_ENTRY_ITEMS, omitted, `+${omitted} more`);
        }
        const line = head.filter(p => p.length > 0).join(' ');
        return items.length > 0 ? `${line} (${items.join(', ')})` : line;
    });
}

/// Describe what a compiled visualization renders, one entry per chart (layer).
/// Markdown lists the fields of its template and not the template itself: the text is presentation, the fields say
/// which columns of the result are shown. Umap lists its columns for the same reason.
export function describeVisualization(visualization: CompiledVisualization): string[] {
    const { renderer } = visualization;
    if (visualization.vegaliteSpec) {
        return describeVegaLite(renderer, visualization.vegaliteSpec);
    }
    if (visualization.markdown) {
        const fields = visualization.markdown.fields;
        return [fields.length > 0 ? `${renderer} (${fields.join(', ')})` : renderer];
    }
    if (visualization.umap) {
        const { vectorColumn, categoryColumn, labelColumn } = visualization.umap;
        const parts = [
            vectorColumn && `vector ${vectorColumn}`,
            categoryColumn && `category ${categoryColumn}`,
            labelColumn && `label ${labelColumn}`,
        ].filter(p => !!p);
        return [parts.length > 0 ? `${renderer} (${parts.join(', ')})` : renderer];
    }
    return [renderer];
}
