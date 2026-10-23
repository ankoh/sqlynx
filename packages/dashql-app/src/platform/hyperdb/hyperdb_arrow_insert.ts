import * as arrow from 'apache-arrow';

/// An Arrow table that Hyper can read with external(format => 'arrowstream').
export interface HyperArrowInsert {
    /// The table with the columns converted to types that Hyper reads
    table: arrow.Table;
    /// The column descriptor of the external scan, Hyper cannot infer it from the Arrow schema
    columns: string;
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

/// The Hyper type of an Arrow type that Hyper reads, null when the column needs converting first.
/// Hyper insists on the type that corresponds to the Arrow type, a wider type is rejected.
function readableHyperType(type: arrow.DataType): string | null {
    switch (type.typeId) {
        case arrow.Type.Int: {
            const int = type as arrow.Int;
            switch (int.bitWidth) {
                case 8:
                case 16:
                    return int.isSigned || int.bitWidth === 8 ? 'smallint' : 'integer';
                case 32:
                    return int.isSigned ? 'integer' : 'bigint';
                case 64:
                    return int.isSigned ? 'bigint' : 'numeric(20,0)';
            }
            return null;
        }
        case arrow.Type.Float:
            switch ((type as arrow.Float).precision) {
                case arrow.Precision.SINGLE:
                    return 'real';
                case arrow.Precision.DOUBLE:
                    return 'double precision';
            }
            return null;
        case arrow.Type.Utf8:
            return 'text';
        case arrow.Type.Binary:
            return 'bytea';
        case arrow.Type.Bool:
            return 'boolean';
        case arrow.Type.Decimal: {
            const decimal = type as arrow.Decimal;
            return decimal.bitWidth === 128 ? `numeric(${decimal.precision},${decimal.scale})` : null;
        }
        case arrow.Type.Date:
            return 'date';
        case arrow.Type.Time:
            return 'time';
        case arrow.Type.Timestamp: {
            const timestamp = type as arrow.Timestamp;
            if (timestamp.unit === arrow.TimeUnit.NANOSECOND) return null;
            return timestamp.timezone == null ? 'timestamp' : 'timestamptz';
        }
        case arrow.Type.Interval:
            return 'interval';
        case arrow.Type.List: {
            const element = readableHyperType((type as arrow.List).valueType);
            return element == null ? null : `${element}[]`;
        }
        default:
            return null;
    }
}

/// Convert a column that Hyper cannot read to a type that it reads.
function convertColumn(vector: arrow.Vector): arrow.Vector {
    const type = vector.type as arrow.DataType;
    switch (type.typeId) {
        case arrow.Type.Dictionary:
            return arrow.vectorFromArray([...vector], (type as arrow.Dictionary).dictionary);
        case arrow.Type.LargeUtf8:
            return arrow.vectorFromArray([...vector], new arrow.Utf8());
        case arrow.Type.LargeBinary:
        case arrow.Type.FixedSizeBinary:
            return arrow.vectorFromArray([...vector], new arrow.Binary());
        case arrow.Type.Float:
            return arrow.vectorFromArray([...vector], new arrow.Float32());
        case arrow.Type.Null:
            return arrow.vectorFromArray(new Array<null>(vector.length).fill(null), new arrow.Utf8());
        case arrow.Type.Timestamp: {
            // Hyper keeps microseconds, nanoseconds are truncated.
            const timezone = (type as arrow.Timestamp).timezone;
            return new arrow.Vector(vector.data.map(data => arrow.makeData({
                type: new arrow.TimestampMicrosecond(timezone),
                length: data.length,
                nullCount: data.nullCount,
                nullBitmap: data.nullBitmap,
                data: (data.values as BigInt64Array).map(value => value / 1000n),
            })));
        }
        default:
            throw new Error(`Hyper cannot import Arrow columns of type ${String(type)}`);
    }
}

/// Prepare an Arrow table for an external Arrow stream scan in Hyper.
export function prepareHyperArrowInsert(table: arrow.Table): HyperArrowInsert {
    const columns: Record<string, arrow.Vector> = {};
    const descriptor: string[] = [];
    let converted = false;
    table.schema.fields.forEach((field, index) => {
        let column = table.getChildAt(index)!;
        let type = readableHyperType(field.type);
        if (type == null) {
            column = convertColumn(column);
            type = readableHyperType(column.type);
            converted = true;
        }
        if (type == null) {
            throw new Error(`Hyper cannot import Arrow columns of type ${String(field.type)}`);
        }
        columns[field.name] = column;
        descriptor.push(`${quoteIdentifier(field.name)} ${type}`);
    });
    // Converted columns are single chunks, the table redistributes the other columns into matching batches.
    return { table: converted ? new arrow.Table(columns) : table, columns: descriptor.join(', ') };
}
