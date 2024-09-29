import * as arrow from 'apache-arrow';

export interface FieldSpec {
    /// The field name
    name: string;
    /// The field type
    type: arrow.DataType;
    /// Is the field nullable?
    nullable: boolean;
    /// The scalar value generator (if scalar)
    generateScalarValue?: (row: number) => any;
    /// The list type (if list)
    listElement?: FieldSpec;
    /// The list length generator
    listLength?: (row: number) => (number | null);
}

export interface RandomDataConfig {
    /// The schema fields
    fields: FieldSpec[];
    /// The result batch count
    resultBatches: number;
    /// The result rows per batch
    resultRowsPerBatch: number;
}

function generateRandomUtf8Data(type: arrow.DataType, nullable: boolean, offset: number, n: number, generateValue: (row: number) => any, encoder: TextEncoder): arrow.Data {
    const ValueArrayType = type.ArrayType;
    const OffsetArrayType = type.OffsetArrayType;
    // Encode values
    let valueOffsets = new OffsetArrayType(n + 1);
    let valueBuffers: (Uint8Array | null)[] = [];
    let valueBufferBytes = 0;
    for (let i = 0; i < n; ++i) {
        const value = generateValue(offset + i) as (string | null);
        if (nullable && (value == null)) {
            valueBuffers.push(null);
        } else {
            const valueBytes = encoder.encode(value!);
            valueBuffers.push(valueBytes);
            valueBufferBytes += valueBytes.length;
        }
    }
    // Write value bytes
    const valueBytes = new ValueArrayType(valueBufferBytes);
    let valueBytesWriter = 0;
    let validityBitmap: Uint8Array = new Uint8Array();
    if (nullable) {
        const validityBytes = ((n + 63) & ~63) >> 3;
        validityBitmap = new Uint8Array(validityBytes).fill(255, 0, validityBytes);
    }
    let nullCount = 0;
    for (let i = 0; i < valueBuffers.length; ++i) {
        valueOffsets[i] = valueBytesWriter;
        const valueBuffer = valueBuffers[i];
        if (valueBuffer == null) {
            const validityByte = i >> 3;
            const validityBit = i & 7;
            const validityMask = 1 << validityBit;
            validityBitmap[validityByte] &= ~validityMask;
            ++nullCount;
        } else {
            valueBytes.set(valueBuffer, valueBytesWriter);
            valueBytesWriter += valueBuffer.length;
        }
    }
    valueOffsets[valueBuffers.length] = valueBytesWriter;
    return new arrow.Data(type, 0, n, nullCount, [
        valueOffsets, valueBytes, validityBitmap
    ]);
}

function generateRandomNumericData(type: arrow.DataType, nullable: boolean, offset: number, n: number, generateValue: (row: number) => any): arrow.Data {
    const ValueArrayType = type.ArrayType;
    const valueBuffer = new ValueArrayType(n);
    let validityBitmap: Uint8Array = new Uint8Array();
    let nullCount = 0;
    if (nullable) {
        const validityBytes = ((n + 63) & ~63) >> 3;
        validityBitmap = new Uint8Array(validityBytes).fill(255, 0, validityBytes);
        for (let i = 0; i < n; ++i) {
            const value = generateValue(offset + i);
            if (value == null) {
                let validityByte = i >> 3;
                let validityBit = i & 7;
                let validityMask = 1 << validityBit;
                validityBitmap[validityByte] &= ~validityMask;
                ++nullCount;
            } else {
                valueBuffer[i] = value!;
            }
        }
    } else {
        for (let i = 0; i < n; ++i) {
            valueBuffer[i] = generateValue(offset + i);
        }
    }
    return new arrow.Data(type, 0, n, nullCount, [
        undefined, valueBuffer, validityBitmap
    ]);
}

function generateRandomDecimal128Data(type: arrow.DataType, nullable: boolean, offset: number, n: number, generateValue: (row: number) => any): arrow.Data {
    const valueBuffer = new Uint32Array(n * 4);
    let validityBitmap: Uint8Array = new Uint8Array();
    let nullCount = 0;
    if (nullable) {
        const validityBytes = ((n + 63) & ~63) >> 3;
        validityBitmap = new Uint8Array(validityBytes).fill(255, 0, validityBytes);
        for (let i = 0; i < n; ++i) {
            const value = generateValue(offset + i);
            if (value == null) {
                let validityByte = i >> 3;
                let validityBit = i & 7;
                let validityMask = 1 << validityBit;
                validityBitmap[validityByte] &= ~validityMask;
                ++nullCount;
            } else {
                valueBuffer.set(value!, i * 4);
            }
        }
    } else {
        for (let i = 0; i < n; ++i) {
            const value = generateValue(offset + i);
            valueBuffer.set(value!, i * 4);
        }
    }
    return new arrow.Data(type, 0, n, nullCount, [
        undefined, valueBuffer, validityBitmap
    ]);
}

function generateRandomBooleanData(type: arrow.DataType, nullable: boolean, offset: number, n: number, generateValue: (row: number) => any) {
    const ValueArrayType = type.ArrayType;
    const valueBuffer = new ValueArrayType(((n + 63) & ~63) >> 3);
    let validityBitmap: Uint8Array = new Uint8Array();
    let nullCount = 0;
    if (nullable) {
        const validityBytes = ((n + 63) & ~63) >> 3;
        validityBitmap = new Uint8Array(validityBytes).fill(255, 0, validityBytes);
        for (let i = 0; i < n; ++i) {
            const value = generateValue(offset + i);
            if (value == null) {
                const validityByte = i >> 3;
                const validityBit = i & 7;
                const validityMask = 1 << validityBit;
                validityBitmap[validityByte] &= ~validityMask;
                ++nullCount;
            } else {
                const valueByte = i >> 3;
                const valueBit = i & 7;
                const valueMask = 1 << valueBit;
                if (value! == true) {
                    valueBuffer[valueByte] |= valueMask;
                }
            }
        }
    } else {
        for (let i = 0; i < n; ++i) {
            const value = generateValue(offset + i);
            const valueByte = i >> 3;
            const valueBit = i & 7;
            const valueMask = 1 << valueBit;
            if (value! == true) {
                valueBuffer[valueByte] |= valueMask;
            }
        }
    }
    return new arrow.Data(type, 0, n, nullCount, [
        undefined, valueBuffer, validityBitmap
    ]);
}

function generateRandomFieldData(fieldSpec: FieldSpec, offset: number, n: number, encoder: TextEncoder): arrow.Data {
    switch (fieldSpec.type.typeId) {
        // Construct UTF8 data
        case arrow.Type.LargeUtf8:
        case arrow.Type.Utf8:
            return generateRandomUtf8Data(
                fieldSpec.type,
                fieldSpec.nullable,
                offset,
                n,
                fieldSpec.generateScalarValue!,
                encoder
            );
        case arrow.Type.Int:
        case arrow.Type.Int8:
        case arrow.Type.Int16:
        case arrow.Type.Int32:
        case arrow.Type.Int64:
        case arrow.Type.Uint8:
        case arrow.Type.Uint16:
        case arrow.Type.Uint32:
        case arrow.Type.Uint64:
        case arrow.Type.Float:
        case arrow.Type.Float16:
        case arrow.Type.Float32:
        case arrow.Type.Float64:
        case arrow.Type.Date:
        case arrow.Type.Time:
        case arrow.Type.Timestamp:
        case arrow.Type.DateDay:
        case arrow.Type.DateMillisecond:
        case arrow.Type.TimestampSecond:
        case arrow.Type.TimestampMillisecond:
        case arrow.Type.TimestampMicrosecond:
        case arrow.Type.TimestampNanosecond:
        case arrow.Type.TimeSecond:
        case arrow.Type.TimeMillisecond:
        case arrow.Type.TimeMicrosecond:
        case arrow.Type.TimeNanosecond:
        case arrow.Type.DurationSecond:
        case arrow.Type.DurationMillisecond:
        case arrow.Type.DurationMicrosecond:
        case arrow.Type.DurationNanosecond:
        case arrow.Type.Duration:
        case arrow.Type.Interval:
        case arrow.Type.IntervalDayTime:
        case arrow.Type.IntervalYearMonth:
            return generateRandomNumericData(
                fieldSpec.type,
                fieldSpec.nullable,
                offset,
                n,
                fieldSpec.generateScalarValue!
            );
        case arrow.Type.Decimal: {
            const decimalType = fieldSpec.type as arrow.Decimal;
            if (decimalType.bitWidth != 128) {
                throw new Error(`cannot generate random data for decimals with bit width != 128`);
            }
            return generateRandomDecimal128Data(
                fieldSpec.type,
                fieldSpec.nullable,
                offset,
                n,
                fieldSpec.generateScalarValue!
            );
        }
        case arrow.Type.Bool:
            return generateRandomBooleanData(
                fieldSpec.type,
                fieldSpec.nullable,
                offset,
                n,
                fieldSpec.generateScalarValue!
            );
        case arrow.Type.List: {
            const listOffsets = new Uint32Array(n + 1);
            let validityBitmap: Uint8Array = new Uint8Array();
            if (fieldSpec.nullable) {
                const validityBytes = ((n + 63) & ~63) >> 3;
                validityBitmap = new Uint8Array(validityBytes).fill(255, 0, validityBytes);
            }
            let nextListOffset = 0;
            let nullCount = 0;
            for (let i = 0; i < n; ++i) {
                listOffsets[i] = nextListOffset;
                const n = fieldSpec.listLength!(i);
                if (n == null) {
                    const validityByte = i >> 3;
                    const validityBit = i & 7;
                    const validityMask = 1 << validityBit;
                    validityBitmap[validityByte] &= ~validityMask;
                    ++nullCount;
                } else {
                    nextListOffset += n;
                }
            }
            listOffsets[n] = nextListOffset;
            const childData = generateRandomFieldData(fieldSpec.listElement!, offset, nextListOffset, encoder);
            return new arrow.Data(fieldSpec.type, 0, n, nullCount, [
                listOffsets, undefined, validityBitmap
            ], [childData]);
        }
        case arrow.Type.NONE:
        case arrow.Type.Binary:
        case arrow.Type.DenseUnion:
        case arrow.Type.Dictionary:
        case arrow.Type.FixedSizeBinary:
        case arrow.Type.FixedSizeList:
        case arrow.Type.LargeBinary:
        case arrow.Type.Map:
        case arrow.Type.Null:
        case arrow.Type.SparseUnion:
        case arrow.Type.Struct:
        case arrow.Type.Struct:
        case arrow.Type.Union:
            throw new Error(`cannot generate random data for type ${fieldSpec.type.toString()}`);
    }
}

export function generateRandomData(config: RandomDataConfig): [arrow.Schema, arrow.RecordBatch[]] {
    const batches: arrow.RecordBatch[] = [];
    const encoder = new TextEncoder();

    // Construct the schema from the field spec
    const schemaFields: arrow.Field[] = [];
    for (let i = 0; i < config.fields.length; ++i) {
        const fieldSpec = config.fields[i];
        schemaFields.push(new arrow.Field(fieldSpec.name, fieldSpec.type, fieldSpec.nullable));
    }
    const schema = new arrow.Schema(schemaFields);

    for (let b = 0; b < config.resultBatches; ++b) {
        const fieldData: arrow.Data[] = [];

        // Generate all field vectors
        for (let f = 0; f < config.fields.length; ++f) {
            const fieldSpec = config.fields[f];
            const data = generateRandomFieldData(fieldSpec, b * config.resultRowsPerBatch, config.resultRowsPerBatch, encoder);
            fieldData.push(data);
        }

        // Pack as struct
        const structData = arrow.makeData({
            nullCount: 0,
            type: new arrow.Struct(schema.fields),
            children: fieldData
        });
        const batch = new arrow.RecordBatch(schema, structData);
        batches.push(batch);
    }
    return [schema, batches];
}
