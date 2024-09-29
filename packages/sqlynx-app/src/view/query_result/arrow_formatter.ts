import * as arrow from 'apache-arrow';
import * as styles from './arrow_formatter.module.css';

export interface ColumnLayoutInfo {
    headerWidth: number;
    valueAvgWidth: number;
    valueMaxWidth: number;
}

export interface ArrowColumnFormatter {
    getColumnName(): string;
    getLayoutInfo(): ColumnLayoutInfo;
    getValue(batch: number, row: number): string;
}

export class ArrowTextColumnFormatter implements ArrowColumnFormatter {
    readonly columnId: number;
    readonly columnName: string;
    readonly batches: arrow.RecordBatch[];
    readonly batchValues: (string[] | null)[];
    readonly valueClassName: string;
    formattedRowCount: number;
    formattedLengthMax: number;
    formattedLengthSum: number;
    formatter: ((o: any) => (null | string));

    public constructor(
        columnId: number,
        schema: arrow.Schema,
        batches: arrow.RecordBatch[]
    ) {
        this.columnId = columnId;
        this.columnName = schema.fields[columnId].name;
        this.valueClassName = styles.data_value_text;
        this.batches = batches;
        this.batchValues = Array.from({ length: batches.length }, () => null);
        this.formattedRowCount = 0;
        this.formattedLengthMax = 0;
        this.formattedLengthSum = 0;
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
                    case arrow.TimeUnit.MILLISECOND:
                        this.formatter = (v: number) => (v == null ? null : fmt.format(new Date(v)));
                        break;
                    case arrow.TimeUnit.MICROSECOND:
                        this.formatter = (v: number) => (v == null ? null : fmt.format(new Date(v / 1000)));
                        break;
                    case arrow.TimeUnit.NANOSECOND:
                        this.formatter = (v: number) => (v == null ? null : fmt.format(new Date(v / 1000 / 1000)));
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
    public ensureBatchIsLoaded(index: number): string[] {
        if (this.batchValues[index] != null) {
            return this.batchValues[index]!;
        }
        const data = this.batches[index];
        const column = data.getChildAt(this.columnId)!;

        const values = [];
        let valueLengthSum = 0;
        let valueLengthMax = 0;
        for (const value of column) {
            const text = this.formatter(value) || '';
            values.push(text);
            valueLengthSum += text.length;
            valueLengthMax = Math.max(valueLengthMax, text.length);
        }
        this.formattedLengthMax = Math.max(this.formattedLengthMax, valueLengthMax)
        this.formattedLengthSum += valueLengthSum;
        this.formattedRowCount += values.length;
        this.batchValues[index] = values;
        return values;
    }

    public getBatchValues(batch: number) {
        return this.ensureBatchIsLoaded(batch);
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
            valueMaxWidth: this.formattedLengthMax,
            valueAvgWidth: this.formattedLengthSum / Math.max(this.formattedRowCount, 1),
        };
    }
}

export class ArrowTableFormatter {
    columns: ArrowColumnFormatter[];
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
        const columns: ArrowColumnFormatter[] = [];
        for (let i = 0; i < schema.fields.length; ++i) {
            const renderer = new ArrowTextColumnFormatter(i, schema, batches);
            columns.push(renderer);
        }
        this.columns = columns;
        this.batchOffsets = batchOffsets;
        this.rowIndex = rowIndex;
    }

    public getValue(row: number, column: number): string {
        const batch = this.rowIndex[row];
        const indexInBatch = row - this.batchOffsets[batch];
        return this.columns[column].getValue(batch, indexInBatch);
    }
}
