import * as arrow from 'apache-arrow';
import * as React from 'react';
import * as styles from './atlas_export_form.module.css';

import { ArrowTableFormatter } from '../../../../../compute/arrow_formatter.js';
import { useLogger } from '../../../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../../../platform/logger/logger.js';
import { selectPlatformDirectory } from '../../../../../shell/shell_files.js';
import { Button, ButtonVariant } from '../../../../../ui/foundations/button.js';
import { Select } from '../../../../../ui/foundations/select.js';
import { useDashQLCoreSetup } from '../../../../providers/core_provider.js';
import {
    buildAtlasExport,
    coreMetadataBlockFinder,
    existingFiles,
    writeAtlasExport,
} from './atlas_export.js';

const LOG_CTX = 'atlas_export';

type ExportStatus =
    | { kind: 'idle' }
    | { kind: 'writing'; done: number; total: number }
    | { kind: 'done'; folder: string; written: number; skipped: number }
    | { kind: 'error'; message: string };

/// The fields that can hold SQL texts, plain or dictionary-encoded strings
export function atlasSqlFields(table: arrow.Table): number[] {
    const fields: number[] = [];
    table.schema.fields.forEach((field, i) => {
        const type = field.type instanceof arrow.Dictionary ? field.type.dictionary : field.type;
        if (type.typeId === arrow.Type.Utf8 || type.typeId === arrow.Type.LargeUtf8) fields.push(i);
    });
    return fields;
}

interface AtlasExportFormProps {
    table: arrow.Table;
    onCancel: () => void;
    /// Called when the export starts and stops writing files
    onBusy: (busy: boolean) => void;
}

/// Write every row of a text column into a .sql file of a folder. The other columns of the row become the metadata
/// of the script, Atlas embeds them next to the structure and the description.
export function AtlasExportForm(props: AtlasExportFormProps): React.ReactElement {
    const logger = useLogger();
    const setupCore = useDashQLCoreSetup();
    const fields = props.table.schema.fields;
    const sqlFields = React.useMemo(() => atlasSqlFields(props.table), [props.table]);
    const [sqlField, setSqlField] = React.useState<number>(() => sqlFields[0]);
    const [status, setStatus] = React.useState<ExportStatus>({ kind: 'idle' });
    const others = React.useMemo(() => fields.map((_, i) => i).filter(f => f !== sqlField), [fields, sqlField]);
    const writing = status.kind === 'writing';

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
                { sqlField, metadataFields: others },
                (row, field) => formatter.getValue(row, field),
                coreMetadataBlockFinder(core),
            );
            const existing = await existingFiles(directory, result.files);
            if (existing.length > 0) {
                const sample = existing.slice(0, 3).join(', ') + (existing.length > 3 ? ', ...' : '');
                if (!window.confirm(`${existing.length} files already exist in ${directory.name} (${sample}). Overwrite them?`)) return;
            }
            props.onBusy(true);
            setStatus({ kind: 'writing', done: 0, total: result.files.length });
            await writeAtlasExport(directory, result.files, (done, total) => setStatus({ kind: 'writing', done, total }));
            logger.info('Exported atlas scripts', { folder: directory.name, scripts: String(result.files.length) }, LOG_CTX);
            setStatus({ kind: 'done', folder: directory.name, written: result.files.length, skipped: result.skipped });
        } catch (e) {
            logger.error('Failed to export atlas scripts', { error: stringifyError(e) }, LOG_CTX);
            setStatus({ kind: 'error', message: stringifyError(e) });
        } finally {
            props.onBusy(false);
        }
    };

    return (
        <form className={styles.form} onSubmit={e => { e.preventDefault(); void exportRows(); }}>
            <label className={styles.field}>
                <span className={styles.label}>SQL Text Column</span>
                <Select
                    block
                    value={sqlField}
                    disabled={writing}
                    onChange={e => setSqlField(Number(e.target.value))}
                >
                    {sqlFields.map(field => <option key={field} value={field}>{fields[field].name}</option>)}
                </Select>
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
            <div className={styles.actions}>
                <Button variant={ButtonVariant.Invisible} onClick={props.onCancel} disabled={writing}>
                    {status.kind === 'done' ? 'Close' : 'Cancel'}
                </Button>
                <Button variant={ButtonVariant.Primary} type="submit" disabled={writing}>Export</Button>
            </div>
        </form>
    );
}
