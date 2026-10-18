import * as arrow from 'apache-arrow';
import * as React from 'react';
import * as styles from './atlas_export_overlay.module.css';

import { ArrowTableFormatter } from '../../../../../compute/arrow_formatter.js';
import { useLogger } from '../../../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../../../platform/logger/logger.js';
import { selectPlatformDirectory } from '../../../../../shell/shell_files.js';
import { AnchoredOverlay } from '../../../../../ui/foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from '../../../../../ui/foundations/anchored_position.js';
import { Button, ButtonSize, ButtonVariant, IconButton } from '../../../../../ui/foundations/button.js';
import { SymbolIcon } from '../../../../../ui/foundations/symbol_icon.js';
import { useDashQLCoreSetup } from '../../../../providers/core_provider.js';
import {
    buildAtlasExport,
    corePropertiesBlockFinder,
    existingFiles,
    writeAtlasExport,
} from './atlas_export.js';

const LOG_CTX = 'atlas_export';

type ExportStatus =
    | { kind: 'idle' }
    | { kind: 'writing'; done: number; total: number }
    | { kind: 'done'; folder: string; written: number; skipped: number }
    | { kind: 'error'; message: string };

interface AtlasExportOverlayProps {
    table: arrow.Table;
    /// The field with the SQL texts
    sqlField: number;
    /// The fields that are shown in the table, the candidates for properties and file names
    visibleFields: number[];
}

/// Write every row of a text column into a .sql file of a folder. The other columns of the row become the properties
/// of the script, Atlas embeds them next to the structure and the description.
export function AtlasExportOverlay(props: AtlasExportOverlayProps): React.ReactElement {
    const logger = useLogger();
    const setupCore = useDashQLCoreSetup();
    const [open, setOpen] = React.useState(false);
    const others = React.useMemo(() => props.visibleFields.filter(f => f !== props.sqlField), [props.visibleFields, props.sqlField]);
    const [selected, setSelected] = React.useState<Set<number>>(() => new Set(others));
    const [nameField, setNameField] = React.useState<number | null>(null);
    const [status, setStatus] = React.useState<ExportStatus>({ kind: 'idle' });
    const fields = props.table.schema.fields;
    const sqlName = fields[props.sqlField].name;
    const MenuIcon = SymbolIcon('kebab_horizontal');
    const CloseIcon = SymbolIcon('x_16');

    React.useEffect(() => setSelected(new Set(others)), [others]);

    const toggle = (field: number) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(field)) next.delete(field);
        else next.add(field);
        return next;
    });

    const exportRows = async () => {
        let directory: FileSystemDirectoryHandle;
        try {
            directory = await selectPlatformDirectory('readwrite');
        } catch (e) {
            // Closing the picker is not an error
            if (e instanceof DOMException && e.name === 'AbortError') return;
            setStatus({ kind: 'error', message: stringifyError(e) });
            return;
        }
        try {
            const core = await setupCore(LOG_CTX);
            const formatter = new ArrowTableFormatter(props.table.schema, props.table.batches, logger);
            const result = buildAtlasExport(
                props.table,
                { sqlField: props.sqlField, propertyFields: others.filter(f => selected.has(f)), nameField },
                (row, field) => formatter.getValue(row, field),
                corePropertiesBlockFinder(core),
            );
            const existing = await existingFiles(directory, result.files);
            if (existing.length > 0) {
                const sample = existing.slice(0, 3).join(', ') + (existing.length > 3 ? ', ...' : '');
                if (!window.confirm(`${existing.length} files already exist in ${directory.name} (${sample}). Overwrite them?`)) return;
            }
            setStatus({ kind: 'writing', done: 0, total: result.files.length });
            await writeAtlasExport(directory, result.files, (done, total) => setStatus({ kind: 'writing', done, total }));
            logger.info('Exported atlas scripts', { folder: directory.name, scripts: String(result.files.length) }, LOG_CTX);
            setStatus({ kind: 'done', folder: directory.name, written: result.files.length, skipped: result.skipped });
        } catch (e) {
            logger.error('Failed to export atlas scripts', { error: stringifyError(e) }, LOG_CTX);
            setStatus({ kind: 'error', message: stringifyError(e) });
        }
    };

    const writing = status.kind === 'writing';
    return (
        <AnchoredOverlay
            open={open}
            onOpen={() => { setStatus({ kind: 'idle' }); setOpen(true); }}
            onClose={() => { if (!writing) setOpen(false); }}
            side={AnchorSide.OutsideBottom}
            align={AnchorAlignment.End}
            anchorOffset={4}
            renderAnchor={(p: object) => {
                const anchorProps = p as React.ButtonHTMLAttributes<HTMLButtonElement>;
                return (
                    <IconButton
                        {...anchorProps}
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        aria-label={`Export ${sqlName} as Atlas`}
                        onClick={e => { e.stopPropagation(); anchorProps.onClick?.(e); }}
                    >
                        <MenuIcon size={16} />
                    </IconButton>
                );
            }}
        >
            {/* The overlay is part of the clickable header cell in the React tree */}
            <section className={styles.card} role="dialog" aria-label="Export as Atlas" onClick={e => e.stopPropagation()}>
                <header className={styles.header}>
                    <h2 className={styles.title}>Export as Atlas</h2>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        onClick={() => setOpen(false)}
                        disabled={writing}
                        aria-label="Close"
                    >
                        <CloseIcon size={16} />
                    </IconButton>
                </header>
                <div className={styles.body}>
                    <p className={styles.hint}>
                        Writes one <code>.sql</code> file per row of <code>{sqlName}</code> into a folder. The selected
                        columns are stored as <code>@dashql:properties</code> of each script.
                    </p>
                    <fieldset className={styles.section} disabled={writing}>
                        <legend className={styles.legend}>Properties</legend>
                        {others.length === 0 && <div className={styles.hint}>There are no other columns.</div>}
                        {others.map(field => (
                            <label key={field} className={styles.option}>
                                <input type="checkbox" checked={selected.has(field)} onChange={() => toggle(field)} />
                                <span>{fields[field].name}</span>
                            </label>
                        ))}
                    </fieldset>
                    <label className={styles.section}>
                        <span className={styles.legend}>File names</span>
                        <select
                            className={styles.select}
                            value={nameField ?? ''}
                            disabled={writing}
                            onChange={e => setNameField(e.target.value === '' ? null : Number(e.target.value))}
                        >
                            <option value="">Row number</option>
                            {others.map(field => <option key={field} value={field}>{fields[field].name}</option>)}
                        </select>
                    </label>
                    {status.kind === 'writing' && <div className={styles.status}>Writing {status.done} of {status.total} files</div>}
                    {status.kind === 'done' && (
                        <div className={styles.status}>
                            Wrote {status.written} scripts to {status.folder}
                            {status.skipped > 0 ? `, skipped ${status.skipped} rows without SQL` : ''}. Open the folder in
                            Atlas to index it.
                        </div>
                    )}
                    {status.kind === 'error' && <div className={styles.error}>{status.message}</div>}
                </div>
                <footer className={styles.footer}>
                    <Button variant={ButtonVariant.Primary} onClick={() => void exportRows()} disabled={writing}>
                        Select folder and export
                    </Button>
                </footer>
            </section>
        </AnchoredOverlay>
    );
}
