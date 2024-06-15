import * as arrow from 'apache-arrow';
import * as styles from './arrow_renderer.module.css';

export interface ColumnLayoutInfo {
    headerWidth: number;
    valueAvgWidth: number;
    valueMaxWidth: number;
}

export interface ColumnRenderer {
    getColumnName(): string;
    getLayoutInfo(): ColumnLayoutInfo;
    getValue(batch: number, row: number): string;
}

export class TextColumnRenderer implements ColumnRenderer {
    readonly columnName: string;
    readonly batches: arrow.RecordBatch[];
    readonly batchOffsets: Uint32Array;
    readonly batchValues: (string[] | null)[];
    readonly currentRowCount: number;
    readonly valueClassName: string;
    valueLengthMax: number;
    valueLengthSum: number;
    formatter: ((o: any) => (null | string));

    public constructor(
        schema: arrow.Schema,
        columnId: number,
        batches: arrow.RecordBatch[],
        batchOffsets: Uint32Array,
    ) {
        this.columnName = schema.fields[columnId].name;
        this.valueClassName = styles.data_value_text;
        this.batches = batches;
        this.batchOffsets = batchOffsets;
        this.batchValues = Array.from({length: batches.length}, () => []);
        this.currentRowCount = 0;
        this.valueLengthMax = 0;
        this.valueLengthSum = 0;
        this.formatter = _ => "";

        // Find formatter and classname
        switch (schema.fields[columnId].type.typeId) {
            case arrow.Type.Int:
            case arrow.Type.Int16:
            case arrow.Type.Int32:
            case arrow.Type.Int64:
            case arrow.Type.Float:
            case arrow.Type.Float16:
            case arrow.Type.Float32:
            case arrow.Type.Float64: {
                this.valueClassName = styles.data_value_number;
                const fmt = Intl.NumberFormat('en-US');
                this.formatter = (v: number) => (v == null ? null : fmt.format(v));
                break;
            }
            case arrow.Type.Utf8:
                this.valueClassName = styles.data_value_text;
                this.formatter = (v: string) => v || null;
                break;
            case arrow.Type.TimeMicrosecond:
                console.warn('not implemented: arrow formatting TimeMicrosecond');
                break;
            case arrow.Type.TimeMillisecond:
                console.warn('not implemented: arrow formatting TimeMillisecond');
                break;
            case arrow.Type.Timestamp: {
                this.valueClassName = styles.data_value_text;
                const type = schema.fields[columnId].type as arrow.Timestamp;
                const fmt = Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'medium' });
                switch (type.unit) {
                    case arrow.TimeUnit.SECOND:
                        this.formatter = (v: number) => (v == null ? null : fmt.format(new Date(v * 1000)));
                        break;
                    case arrow.TimeUnit.MICROSECOND:
                        this.formatter = (v: number) => (v == null ? null : fmt.format(new Date(v)));
                        break;
                    case arrow.TimeUnit.MILLISECOND:
                    case arrow.TimeUnit.NANOSECOND:
                        console.warn('not implemented: arrow formatting Timestamp');
                        break;
                }
                break;
            }
            case arrow.Type.TimestampMicrosecond:
                console.warn('not implemented: arrow formatting TimestampMicrosecond');
                break;
            case arrow.Type.TimestampMillisecond:
                console.warn('not implemented: arrow formatting TimestampMillisecond');
                break;
            case arrow.Type.TimestampNanosecond:
                console.warn('not implemented: arrow formatting TimestampNanosecond');
                break;
            case arrow.Type.TimeSecond:
                console.warn('not implemented: arrow formatting TimeSecond');
                break;
            case arrow.Type.DateMillisecond:
            case arrow.Type.DateDay:
            case arrow.Type.Date: {
                this.valueClassName = styles.data_value_text;
                const fmt = Intl.DateTimeFormat('en-US', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                });
                this.formatter = (v: number) => (v == null ? null : fmt.format(v));
                break;
            }
            default:
                break;
        }
    }
    public ensureLoaded(index: number): string[] {
        if (this.batchValues[index] != null) {
            return this.batchValues[index]!;
        }
        const data = this.batches[index];
        const column = data.getChildAt(index)!;

        const values = [];
        let valueLengthSum = 0;
        let valueLengthMax = 0;
        for (const value of column) {
            const text = this.formatter(value) || '';
            values.push(text);
            valueLengthSum += text.length;
            valueLengthMax = Math.max(valueLengthMax, text.length);
        }
        this.valueLengthMax = Math.max(this.valueLengthMax, valueLengthMax)
        this.valueLengthSum += valueLengthSum;
        this.batchValues[index] = values;
        return values;
    }

    public getBatchValues(batch: number) {
        return this.ensureLoaded(batch);
    }
    public getValue(batch: number, row: number): string {
        return this.getBatchValues(batch)[row];
    }
    public getColumnName(): string {
        return this.columnName;
    }
    public getLayoutInfo(): ColumnLayoutInfo {
        return {
            headerWidth: this.columnName.length,
            valueMaxWidth: this.valueLengthMax,
            valueAvgWidth: this.valueLengthSum / this.currentRowCount,
        };
    }
}

export class TableRenderer {
    columns: ColumnRenderer[];
    batchOffsets: Uint32Array;
    rowIndex: Uint32Array;

    public constructor(schema: arrow.Schema, batches: arrow.RecordBatch[]) {
        const batchOffsets = new Uint32Array(batches.length);
        let numRows = 0;
        for (let i = 0; i < batches.length; ++i) {
            batchOffsets[i] = numRows;
            numRows += batches[i].numRows;
        }
        const rowIndex = new Uint32Array(numRows);
        let rowIndexWriter = 0;
        for (let i = 0; i < batches.length; ++i) {
            for (let j = 0; j < batches[i].numRows; ++j) {
                rowIndex[rowIndexWriter++] = i;
            }
        }
        const columns: ColumnRenderer[] = [];
        for (let i = 0; i < schema.fields.length; ++i) {
            const renderer = new TextColumnRenderer(schema, i, batches, batchOffsets);
            columns.push(renderer);
        }
        this.columns = columns;
        this.batchOffsets = batchOffsets;
        this.rowIndex = rowIndex;
    }

    public getValue(row: number): string {
        const batch = this.rowIndex[row];
        const indexInBatch = row - this.batchOffsets[batch];
        return this.getValue(batch)[indexInBatch];
    }
}