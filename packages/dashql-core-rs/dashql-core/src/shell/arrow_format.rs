//! Arrow values as text, the way Arrow C++ 19 prints them with `Scalar::ToString()`.
//!
//! The C++ shell renders every cell with `array.GetScalar(row)->ToString()`, which casts the scalar
//! to a string (`arrow/scalar.cc`, `arrow/util/formatting.h`):
//! - numbers use the `StringFormatter`s, floats double-conversion's shortest representation
//!   (`EMIT_POSITIVE_EXPONENT_SIGN`, "inf", "nan", fixed notation for exponents in [-6, 10)),
//! - strings and binaries are their raw bytes, decimals `Decimal*::ToString(scale)`,
//! - temporal values ISO-like with an out-of-range marker, durations their raw count,
//! - nested values embed the C++ `DataType::ToString()` of their type,
//! - dictionary values print the whole dictionary with `PrettyPrint` followed by the index.

use arrow_array::cast::AsArray;
use arrow_array::types::*;
use arrow_array::{Array, ArrowPrimitiveType};
use arrow_schema::{DataType, Field, IntervalUnit, TimeUnit, UnionMode};

/// Is the value at `i` null in Arrow C++ (`Array::IsNull`)? Arrays without a validity bitmap are null when the
/// null count equals the length (null arrays), unions follow their selected child.
pub fn is_null(array: &dyn Array, i: usize) -> bool {
    is_null_in_slice(array, i, 0)
}

/// `Array::IsNull` of the value at the absolute index `i` of an array that Arrow C++ sliced at `base`
/// (list elements, struct fields of list elements). `IsNullSparseUnion` reads the unsliced child at the relative
/// index, so sliced sparse unions report the nulls of other rows.
fn is_null_in_slice(array: &dyn Array, i: usize, base: usize) -> bool {
    match array.data_type() {
        DataType::Null => true,
        DataType::Union(_, mode) => {
            let union = array.as_union();
            let child = union.child(union.type_id(i));
            match mode {
                // `IsNull` checks the unsliced child at the relative index, the scalar is null if its value is
                UnionMode::Sparse => is_null_in_slice(child.as_ref(), i - base, 0) || is_null_in_slice(child.as_ref(), i, base),
                UnionMode::Dense => is_null_in_slice(child.as_ref(), union.value_offset(i), 0),
            }
        }
        _ => array.nulls().is_some_and(|nulls| nulls.is_null(i)),
    }
}

/// The C++ `TimeUnit` suffix
fn time_unit(unit: &TimeUnit) -> &'static str {
    match unit {
        TimeUnit::Second => "s",
        TimeUnit::Millisecond => "ms",
        TimeUnit::Microsecond => "us",
        TimeUnit::Nanosecond => "ns",
    }
}

/// `Field::ToString()`
pub fn field_to_string(field: &Field) -> String {
    let mut out = format!("{}: {}", field.name(), type_to_string(field.data_type()));
    if !field.is_nullable() {
        out.push_str(" not null");
    }
    out
}

/// `DataType::ToString()`
pub fn type_to_string(data_type: &DataType) -> String {
    match data_type {
        DataType::Null => "null".into(),
        DataType::Boolean => "bool".into(),
        DataType::Int8 => "int8".into(),
        DataType::Int16 => "int16".into(),
        DataType::Int32 => "int32".into(),
        DataType::Int64 => "int64".into(),
        DataType::UInt8 => "uint8".into(),
        DataType::UInt16 => "uint16".into(),
        DataType::UInt32 => "uint32".into(),
        DataType::UInt64 => "uint64".into(),
        DataType::Float16 => "halffloat".into(),
        DataType::Float32 => "float".into(),
        DataType::Float64 => "double".into(),
        DataType::Timestamp(unit, tz) => match tz.as_deref() {
            Some(tz) if !tz.is_empty() => format!("timestamp[{}, tz={}]", time_unit(unit), tz),
            _ => format!("timestamp[{}]", time_unit(unit)),
        },
        DataType::Date32 => "date32[day]".into(),
        DataType::Date64 => "date64[ms]".into(),
        DataType::Time32(unit) => format!("time32[{}]", time_unit(unit)),
        DataType::Time64(unit) => format!("time64[{}]", time_unit(unit)),
        DataType::Duration(unit) => format!("duration[{}]", time_unit(unit)),
        DataType::Interval(IntervalUnit::YearMonth) => "month_interval".into(),
        DataType::Interval(IntervalUnit::DayTime) => "day_time_interval".into(),
        DataType::Interval(IntervalUnit::MonthDayNano) => "month_day_nano_interval".into(),
        DataType::Binary => "binary".into(),
        DataType::FixedSizeBinary(width) => format!("fixed_size_binary[{}]", width),
        DataType::LargeBinary => "large_binary".into(),
        DataType::BinaryView => "binary_view".into(),
        DataType::Utf8 => "string".into(),
        DataType::LargeUtf8 => "large_string".into(),
        DataType::Utf8View => "string_view".into(),
        DataType::List(field) => format!("list<{}>", field_to_string(field)),
        DataType::ListView(field) => format!("list_view<{}>", field_to_string(field)),
        DataType::LargeList(field) => format!("large_list<{}>", field_to_string(field)),
        DataType::LargeListView(field) => format!("large_list_view<{}>", field_to_string(field)),
        DataType::FixedSizeList(field, size) => format!("fixed_size_list<{}>[{}]", field_to_string(field), size),
        DataType::Struct(fields) => {
            let fields: Vec<String> = fields.iter().map(|f| field_to_string(f)).collect();
            format!("struct<{}>", fields.join(", "))
        }
        DataType::Union(fields, mode) => {
            let name = match mode {
                UnionMode::Sparse => "sparse_union",
                UnionMode::Dense => "dense_union",
            };
            let children: Vec<String> = fields.iter().map(|(code, f)| format!("{}={}", field_to_string(f), code)).collect();
            format!("{}<{}>", name, children.join(", "))
        }
        DataType::Dictionary(key, value) => {
            format!("dictionary<values={}, indices={}, ordered=0>", type_to_string(value), type_to_string(key))
        }
        DataType::Decimal32(p, s) => format!("decimal32({}, {})", p, s),
        DataType::Decimal64(p, s) => format!("decimal64({}, {})", p, s),
        DataType::Decimal128(p, s) => format!("decimal128({}, {})", p, s),
        DataType::Decimal256(p, s) => format!("decimal256({}, {})", p, s),
        DataType::Map(entries, sorted) => {
            let field_name = |out: &mut String, field: &Field, std_name: &str| {
                if field.name() != std_name {
                    out.push_str(&format!(" ('{}')", field.name()));
                }
            };
            let mut out = String::from("map<");
            if let DataType::Struct(kv) = entries.data_type() {
                if kv.len() == 2 {
                    out.push_str(&type_to_string(kv[0].data_type()));
                    field_name(&mut out, &kv[0], "key");
                    out.push_str(", ");
                    out.push_str(&type_to_string(kv[1].data_type()));
                    field_name(&mut out, &kv[1], "value");
                }
            }
            if *sorted {
                out.push_str(", keys_sorted");
            }
            field_name(&mut out, entries, "entries");
            out.push('>');
            out
        }
        DataType::RunEndEncoded(run_ends, values) => {
            format!("run_end_encoded<run_ends: {}, values: {}>", type_to_string(run_ends.data_type()), type_to_string(values.data_type()))
        }
    }
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/// Lay out shortest digits like double-conversion's `ToShortest` with Arrow's converter settings
fn format_shortest(negative: bool, scientific: &str, out: &mut Vec<u8>) {
    // `scientific` is Rust's shortest `{:e}` representation of the absolute value, e.g. "1.25e-7"
    let (mantissa, exponent) = scientific.split_once('e').unwrap();
    let exponent: i32 = exponent.parse().unwrap();
    let digits: Vec<u8> = mantissa.bytes().filter(|&c| c != b'.').collect();
    let length = digits.len() as i32;
    let decimal_point = exponent + 1;
    if negative {
        out.push(b'-');
    }
    if (-6..10).contains(&exponent) {
        let digits_after_point = (length - decimal_point).max(0);
        if decimal_point <= 0 {
            out.push(b'0');
            if digits_after_point > 0 {
                out.push(b'.');
                out.extend(std::iter::repeat_n(b'0', (-decimal_point) as usize));
                out.extend_from_slice(&digits);
            }
        } else if decimal_point >= length {
            out.extend_from_slice(&digits);
            out.extend(std::iter::repeat_n(b'0', (decimal_point - length) as usize));
        } else {
            out.extend_from_slice(&digits[..decimal_point as usize]);
            out.push(b'.');
            out.extend_from_slice(&digits[decimal_point as usize..]);
        }
    } else {
        out.push(digits[0]);
        if length != 1 {
            out.push(b'.');
            out.extend_from_slice(&digits[1..]);
        }
        out.push(b'e');
        if exponent < 0 {
            out.push(b'-');
        } else {
            out.push(b'+');
        }
        out.extend_from_slice(exponent.unsigned_abs().to_string().as_bytes());
    }
}

/// The shortest representation of a float as double-conversion generates it. Rust and double-conversion find the
/// same shortest digits, but when the exact value lies halfway between two shortest candidates, Rust rounds up and
/// double-conversion's bignum fallback rounds to an even last digit (`GenerateShortestDigits`).
fn shortest_scientific(shortest: String, exact_value: f64) -> String {
    let (mantissa, exponent) = shortest.split_once('e').unwrap();
    let digits: Vec<u8> = mantissa.bytes().filter(|&c| c != b'.').collect();
    let n = digits.len();
    // A halfway case has an exact expansion of n + 1 digits that ends in 5
    let probe = format!("{:.*e}", n, exact_value);
    if !probe.split_once('e').unwrap().0.ends_with('5') {
        return shortest;
    }
    let exact = format!("{:.800e}", exact_value);
    let (exact_mantissa, exact_exponent) = exact.split_once('e').unwrap();
    let exact_digits: Vec<u8> = exact_mantissa.bytes().filter(|&c| c != b'.').collect();
    if exact_exponent != exponent || exact_digits[n] != b'5' || exact_digits[n + 1..].iter().any(|&c| c != b'0') {
        return shortest;
    }
    let truncated = &exact_digits[..n];
    if truncated == digits.as_slice() || (truncated[n - 1] - b'0') % 2 != 0 {
        return shortest;
    }
    let mut out = String::with_capacity(shortest.len());
    out.push(truncated[0] as char);
    if n > 1 {
        out.push('.');
        out.extend(truncated[1..].iter().map(|&c| c as char));
    }
    out.push('e');
    out.push_str(exponent);
    out
}

/// `FloatToStringFormatter::FormatFloat(double)`
pub fn format_f64(value: f64, out: &mut Vec<u8>) {
    if value.is_nan() {
        out.extend_from_slice(b"nan");
    } else if value.is_infinite() {
        out.extend_from_slice(if value < 0.0 { b"-inf" } else { b"inf" });
    } else {
        let shortest = shortest_scientific(format!("{:e}", value.abs()), value.abs());
        format_shortest(value.is_sign_negative(), &shortest, out);
    }
}

/// `FloatToStringFormatter::FormatFloat(float)` (`ToShortestSingle`)
pub fn format_f32(value: f32, out: &mut Vec<u8>) {
    if value.is_nan() {
        out.extend_from_slice(b"nan");
    } else if value.is_infinite() {
        out.extend_from_slice(if value < 0.0 { b"-inf" } else { b"inf" });
    } else {
        let shortest = shortest_scientific(format!("{:e}", value.abs()), value.abs() as f64);
        format_shortest(value.is_sign_negative(), &shortest, out);
    }
}

/// `AdjustIntegerStringWithScale` of `Decimal*::ToString(scale)`
fn format_decimal(integer: String, scale: i32, max_scale: i32, name: &str, out: &mut Vec<u8>) {
    if scale < -max_scale || scale > max_scale {
        out.extend_from_slice(format!("<scale out of range, cannot format {} value>", name).as_bytes());
        return;
    }
    let mut s = integer.into_bytes();
    if scale != 0 {
        let negative = s[0] == b'-';
        let offset = negative as i32;
        let len = s.len() as i32;
        let num_digits = len - offset;
        let adjusted_exponent = num_digits - 1 - scale;
        if scale < 0 || adjusted_exponent < -6 {
            if num_digits > 1 {
                s.insert((1 + offset) as usize, b'.');
            }
            s.push(b'E');
            if adjusted_exponent >= 0 {
                s.push(b'+');
            }
            s.extend_from_slice(adjusted_exponent.to_string().as_bytes());
        } else if num_digits > scale {
            s.insert((len - scale) as usize, b'.');
        } else {
            let zeros = (scale - num_digits + 2) as usize;
            let at = offset as usize;
            s.splice(at..at, std::iter::repeat_n(b'0', zeros));
            s[at + 1] = b'.';
        }
    }
    out.extend_from_slice(&s);
}

// ---------------------------------------------------------------------------
// Dates and times (arrow_vendored::date)
// ---------------------------------------------------------------------------

const DAYS_MIN_INCL: i64 = -12687428;
const DAYS_MAX_EXCL: i64 = 11248738;
const SECONDS_PER_DAY: i64 = 86400;

/// `year_month_day` of days since the epoch (`civil_from_days`)
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `FormatYYYY_MM_DD`
fn format_date(days: i64, out: &mut Vec<u8>) {
    let (year, month, day) = civil_from_days(days);
    if year < 0 {
        out.push(b'-');
    }
    out.extend_from_slice(format!("{:04}-{:02}-{:02}", year.unsigned_abs(), month, day).as_bytes());
}

/// The ticks of a time unit per second and the number of subsecond digits
fn unit_scale(unit: &TimeUnit) -> (i64, usize) {
    match unit {
        TimeUnit::Second => (1, 0),
        TimeUnit::Millisecond => (1_000, 3),
        TimeUnit::Microsecond => (1_000_000, 6),
        TimeUnit::Nanosecond => (1_000_000_000, 9),
    }
}

/// `FormatHH_MM_SS` of a non-negative duration since midnight
fn format_time_of_day(ticks: i64, unit: &TimeUnit, out: &mut Vec<u8>) {
    let (per_second, digits) = unit_scale(unit);
    let seconds = ticks / per_second;
    let subseconds = ticks % per_second;
    out.extend_from_slice(format!("{:02}:{:02}:{:02}", seconds / 3600, (seconds / 60) % 60, seconds % 60).as_bytes());
    if digits != 0 {
        out.extend_from_slice(format!(".{:0width$}", subseconds, width = digits).as_bytes());
    }
}

fn format_out_of_range(value: i64, out: &mut Vec<u8>) {
    out.extend_from_slice(format!("<value out of range: {}>", value).as_bytes());
}

/// Is a duration in a unit within the date range of `arrow_vendored::date` (`IsDateTimeInRange`)?
fn date_time_in_range(value: i64, unit: &TimeUnit) -> bool {
    let (per_second, _) = unit_scale(unit);
    if per_second == 1_000_000_000 {
        return true;
    }
    let ticks_per_day = SECONDS_PER_DAY * per_second;
    (value as i128) >= (DAYS_MIN_INCL * ticks_per_day) as i128 && (value as i128) < (DAYS_MAX_EXCL * ticks_per_day) as i128
}

fn format_date32(value: i32, out: &mut Vec<u8>) {
    let days = value as i64;
    if !(DAYS_MIN_INCL..DAYS_MAX_EXCL).contains(&days) {
        return format_out_of_range(days, out);
    }
    format_date(days, out);
}

fn format_date64(value: i64, out: &mut Vec<u8>) {
    if !date_time_in_range(value, &TimeUnit::Millisecond) {
        return format_out_of_range(value, out);
    }
    // duration_cast<days> truncates towards zero
    format_date(value / (SECONDS_PER_DAY * 1000), out);
}

fn format_timestamp(value: i64, unit: &TimeUnit, tz: Option<&str>, out: &mut Vec<u8>) {
    if !date_time_in_range(value, unit) {
        return format_out_of_range(value, out);
    }
    let (per_second, _) = unit_scale(unit);
    let ticks_per_day = SECONDS_PER_DAY * per_second;
    // time_point_cast<days> truncates towards zero
    let mut days = value / ticks_per_day;
    let since_midnight = if days * ticks_per_day <= value {
        value - days * ticks_per_day
    } else {
        days -= 1;
        ticks_per_day + (value - (days + 1) * ticks_per_day)
    };
    format_date(days, out);
    out.push(b' ');
    format_time_of_day(since_midnight, unit, out);
    if tz.is_some_and(|tz| !tz.is_empty()) {
        out.push(b'Z');
    }
}

fn format_time(value: i64, unit: &TimeUnit, out: &mut Vec<u8>) {
    let (per_second, _) = unit_scale(unit);
    if value < 0 || value >= SECONDS_PER_DAY * per_second {
        return format_out_of_range(value, out);
    }
    format_time_of_day(value, unit, out);
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

fn primitive<T: ArrowPrimitiveType>(array: &dyn Array, i: usize) -> T::Native {
    array.as_primitive::<T>().value(i)
}

fn push_display(value: impl std::fmt::Display, out: &mut Vec<u8>) {
    out.extend_from_slice(value.to_string().as_bytes());
}

/// The text of a primitive value (`StringFormatter<T>`), None for types without a formatter
fn format_primitive(array: &dyn Array, i: usize, out: &mut Vec<u8>) -> bool {
    match array.data_type() {
        DataType::Boolean => out.extend_from_slice(if array.as_boolean().value(i) { b"true" } else { b"false" }),
        DataType::Int8 => push_display(primitive::<Int8Type>(array, i), out),
        DataType::Int16 => push_display(primitive::<Int16Type>(array, i), out),
        DataType::Int32 => push_display(primitive::<Int32Type>(array, i), out),
        DataType::Int64 => push_display(primitive::<Int64Type>(array, i), out),
        DataType::UInt8 => push_display(primitive::<UInt8Type>(array, i), out),
        DataType::UInt16 => push_display(primitive::<UInt16Type>(array, i), out),
        DataType::UInt32 => push_display(primitive::<UInt32Type>(array, i), out),
        DataType::UInt64 => push_display(primitive::<UInt64Type>(array, i), out),
        DataType::Float16 => format_f64(primitive::<Float16Type>(array, i).to_f32() as f64, out),
        DataType::Float32 => format_f32(primitive::<Float32Type>(array, i), out),
        DataType::Float64 => format_f64(primitive::<Float64Type>(array, i), out),
        DataType::Decimal32(_, s) => format_decimal(primitive::<Decimal32Type>(array, i).to_string(), *s as i32, 9, "Decimal32", out),
        DataType::Decimal64(_, s) => format_decimal(primitive::<Decimal64Type>(array, i).to_string(), *s as i32, 18, "Decimal64", out),
        DataType::Decimal128(_, s) => format_decimal(primitive::<Decimal128Type>(array, i).to_string(), *s as i32, 38, "Decimal128", out),
        DataType::Decimal256(_, s) => format_decimal(primitive::<Decimal256Type>(array, i).to_string(), *s as i32, 76, "Decimal256", out),
        DataType::Date32 => format_date32(primitive::<Date32Type>(array, i), out),
        DataType::Date64 => format_date64(primitive::<Date64Type>(array, i), out),
        DataType::Time32(unit) => {
            let value = match unit {
                TimeUnit::Second => primitive::<Time32SecondType>(array, i),
                _ => primitive::<Time32MillisecondType>(array, i),
            };
            format_time(value as i64, unit, out)
        }
        DataType::Time64(unit) => {
            let value = match unit {
                TimeUnit::Microsecond => primitive::<Time64MicrosecondType>(array, i),
                _ => primitive::<Time64NanosecondType>(array, i),
            };
            format_time(value, unit, out)
        }
        DataType::Timestamp(unit, tz) => {
            let value = match unit {
                TimeUnit::Second => primitive::<TimestampSecondType>(array, i),
                TimeUnit::Millisecond => primitive::<TimestampMillisecondType>(array, i),
                TimeUnit::Microsecond => primitive::<TimestampMicrosecondType>(array, i),
                TimeUnit::Nanosecond => primitive::<TimestampNanosecondType>(array, i),
            };
            format_timestamp(value, unit, tz.as_deref(), out)
        }
        DataType::Duration(unit) => {
            let value = match unit {
                TimeUnit::Second => primitive::<DurationSecondType>(array, i),
                TimeUnit::Millisecond => primitive::<DurationMillisecondType>(array, i),
                TimeUnit::Microsecond => primitive::<DurationMicrosecondType>(array, i),
                TimeUnit::Nanosecond => primitive::<DurationNanosecondType>(array, i),
            };
            push_display(value, out)
        }
        DataType::Interval(IntervalUnit::YearMonth) => {
            out.extend_from_slice(format!("{}M", primitive::<IntervalYearMonthType>(array, i)).as_bytes())
        }
        DataType::Interval(IntervalUnit::DayTime) => {
            let v = primitive::<IntervalDayTimeType>(array, i);
            out.extend_from_slice(format!("{}d{}ms", v.days, v.milliseconds).as_bytes())
        }
        DataType::Interval(IntervalUnit::MonthDayNano) => {
            let v = primitive::<IntervalMonthDayNanoType>(array, i);
            out.extend_from_slice(format!("{}M{}d{}ns", v.months, v.days, v.nanoseconds).as_bytes())
        }
        _ => return false,
    }
    true
}

/// The raw bytes of a binary-like value
fn binary_value(array: &dyn Array, i: usize) -> Option<&[u8]> {
    Some(match array.data_type() {
        DataType::Utf8 => array.as_string::<i32>().value(i).as_bytes(),
        DataType::LargeUtf8 => array.as_string::<i64>().value(i).as_bytes(),
        DataType::Utf8View => array.as_string_view().value(i).as_bytes(),
        DataType::Binary => array.as_binary::<i32>().value(i),
        DataType::LargeBinary => array.as_binary::<i64>().value(i),
        DataType::BinaryView => array.as_binary_view().value(i),
        DataType::FixedSizeBinary(_) => array.as_fixed_size_binary().value(i),
        _ => return None,
    })
}

/// The elements of a list-like value as (values, offset, length)
fn list_value(array: &dyn Array, i: usize) -> Option<(&dyn Array, usize, usize)> {
    Some(match array.data_type() {
        DataType::List(_) => {
            let list = array.as_list::<i32>();
            let offsets = list.value_offsets();
            (list.values().as_ref(), offsets[i] as usize, (offsets[i + 1] - offsets[i]) as usize)
        }
        DataType::LargeList(_) => {
            let list = array.as_list::<i64>();
            let offsets = list.value_offsets();
            (list.values().as_ref(), offsets[i] as usize, (offsets[i + 1] - offsets[i]) as usize)
        }
        DataType::ListView(_) => {
            let list = array.as_list_view::<i32>();
            (list.values().as_ref(), list.value_offsets()[i] as usize, list.value_sizes()[i] as usize)
        }
        DataType::LargeListView(_) => {
            let list = array.as_list_view::<i64>();
            (list.values().as_ref(), list.value_offsets()[i] as usize, list.value_sizes()[i] as usize)
        }
        DataType::FixedSizeList(_, size) => {
            let list = array.as_fixed_size_list();
            (list.values().as_ref(), i * *size as usize, *size as usize)
        }
        DataType::Map(_, _) => {
            let map = array.as_map();
            let offsets = map.value_offsets();
            (map.entries() as &dyn Array, offsets[i] as usize, (offsets[i + 1] - offsets[i]) as usize)
        }
        _ => return None,
    })
}

/// The integer of a dictionary key
fn key_to_string(keys: &dyn Array, i: usize, out: &mut Vec<u8>) {
    format_primitive(keys, i, out);
}

/// `Scalar::ToString()` of the value at `i`, "null" for nulls
pub fn scalar_to_string(array: &dyn Array, i: usize, out: &mut Vec<u8>) {
    scalar_in_slice_to_string(array, i, 0, out)
}

/// `Scalar::ToString()` of the value at the absolute index `i` of an array that Arrow C++ sliced at `base`
fn scalar_in_slice_to_string(array: &dyn Array, i: usize, base: usize, out: &mut Vec<u8>) {
    if is_null_in_slice(array, i, base) {
        out.extend_from_slice(b"null");
        return;
    }
    if let Some(bytes) = binary_value(array, i) {
        out.extend_from_slice(bytes);
        return;
    }
    if format_primitive(array, i, out) {
        return;
    }
    if let Some((values, offset, length)) = list_value(array, i) {
        out.extend_from_slice(type_to_string(array.data_type()).as_bytes());
        out.push(b'[');
        for j in 0..length {
            if j > 0 {
                out.extend_from_slice(b", ");
            }
            scalar_in_slice_to_string(values, offset + j, offset, out);
        }
        out.push(b']');
        return;
    }
    match array.data_type() {
        DataType::Struct(fields) => {
            let array = array.as_struct();
            out.push(b'{');
            for (j, field) in fields.iter().enumerate() {
                if j > 0 {
                    out.extend_from_slice(b", ");
                }
                out.extend_from_slice(format!("{}:{} = ", field.name(), type_to_string(field.data_type())).as_bytes());
                scalar_in_slice_to_string(array.column(j).as_ref(), i, base, out);
            }
            out.push(b'}');
        }
        DataType::Union(fields, mode) => {
            let union = array.as_union();
            let type_id = union.type_id(i);
            let child = union.child(type_id);
            let index = match mode {
                UnionMode::Sparse => i,
                UnionMode::Dense => union.value_offset(i),
            };
            out.extend_from_slice(b"union{");
            if let Some((_, field)) = fields.iter().find(|(code, _)| *code == type_id) {
                out.extend_from_slice(field_to_string(field).as_bytes());
            }
            out.extend_from_slice(b" = ");
            let child_base = match mode {
                UnionMode::Sparse => base,
                UnionMode::Dense => 0,
            };
            scalar_in_slice_to_string(child.as_ref(), index, child_base, out);
            out.push(b'}');
        }
        DataType::Dictionary(_, _) => {
            let dictionary = array.as_any_dictionary();
            pretty_print(dictionary.values().as_ref(), out);
            out.push(b'[');
            key_to_string(dictionary.keys(), i, out);
            out.push(b']');
        }
        _ => {}
    }
}

/// `PrettyPrint(array)` with the default options (window 10), for the dictionaries of dictionary scalars
pub fn pretty_print(array: &dyn Array, out: &mut Vec<u8>) {
    const WINDOW: usize = 10;
    let length = array.len();
    out.push(b'[');
    if length > 0 {
        out.push(b'\n');
    }
    let mut i = 0;
    while i < length {
        let is_last = i == length - 1;
        if length != 2 * WINDOW + 1 && i >= WINDOW && i < length - WINDOW {
            out.extend_from_slice(b"  ...");
            i = length - WINDOW - 1;
        } else {
            out.extend_from_slice(b"  ");
            if is_null(array, i) {
                out.extend_from_slice(b"null");
            } else {
                pretty_print_value(array, i, out);
            }
            if !is_last {
                out.push(b',');
            }
        }
        out.push(b'\n');
        i += 1;
    }
    out.push(b']');
}

fn pretty_print_value(array: &dyn Array, i: usize, out: &mut Vec<u8>) {
    match array.data_type() {
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => {
            out.push(b'"');
            out.extend_from_slice(binary_value(array, i).unwrap());
            out.push(b'"');
        }
        DataType::Binary | DataType::LargeBinary | DataType::BinaryView | DataType::FixedSizeBinary(_) => {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            for &b in binary_value(array, i).unwrap() {
                out.push(HEX[(b >> 4) as usize]);
                out.push(HEX[(b & 15) as usize]);
            }
        }
        // "XXX do not know how to format half floats yet": the raw bits as int16
        DataType::Float16 => push_display(primitive::<Float16Type>(array, i).to_bits() as i16, out),
        _ => {
            if !format_primitive(array, i, out) {
                scalar_to_string(array, i, out);
            }
        }
    }
}

/// Is a column type right-aligned (`IsRightAligned`)?
pub fn is_right_aligned(data_type: &DataType) -> bool {
    matches!(
        data_type,
        DataType::Boolean
            | DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Float16
            | DataType::Float32
            | DataType::Float64
            | DataType::Decimal32(_, _)
            | DataType::Decimal64(_, _)
            | DataType::Decimal128(_, _)
            | DataType::Decimal256(_, _)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f64s(v: f64) -> String {
        let mut out = Vec::new();
        format_f64(v, &mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn floats_like_double_conversion() {
        assert_eq!(f64s(0.0), "0");
        assert_eq!(f64s(-0.0), "-0");
        assert_eq!(f64s(1.0), "1");
        assert_eq!(f64s(1.5), "1.5");
        assert_eq!(f64s(123456789.0), "123456789");
        assert_eq!(f64s(1e9), "1000000000");
        assert_eq!(f64s(1e10), "1e+10");
        assert_eq!(f64s(1.25e10), "1.25e+10");
        assert_eq!(f64s(0.000001), "0.000001");
        assert_eq!(f64s(0.0000001), "1e-7");
        assert_eq!(f64s(-2.5e-7), "-2.5e-7");
        assert_eq!(f64s(f64::INFINITY), "inf");
        assert_eq!(f64s(f64::NEG_INFINITY), "-inf");
        assert_eq!(f64s(f64::NAN), "nan");
        // Halfway cases round to an even digit
        assert_eq!(f64s(0.00093555450439453125), "0.0009355545043945312");
    }

    fn decimal(v: &str, scale: i32) -> String {
        let mut out = Vec::new();
        format_decimal(v.to_string(), scale, 38, "Decimal128", &mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn decimals_like_arrow() {
        assert_eq!(decimal("123", 1), "12.3");
        assert_eq!(decimal("-123", 1), "-12.3");
        assert_eq!(decimal("123", 4), "0.0123");
        assert_eq!(decimal("-123", 4), "-0.0123");
        assert_eq!(decimal("123", -2), "1.23E+4");
        assert_eq!(decimal("-123", 9), "-1.23E-7");
        assert_eq!(decimal("0", -1), "0E+1");
        assert_eq!(decimal("5", 0), "5");
        assert_eq!(decimal("5", 39), "<scale out of range, cannot format Decimal128 value>");
    }

    #[test]
    fn dates_like_arrow() {
        let date = |d: i64| {
            let mut out = Vec::new();
            format_date(d, &mut out);
            String::from_utf8(out).unwrap()
        };
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(-1), "1969-12-31");
        assert_eq!(date(19000), "2022-01-08");
        assert_eq!(date(-719528), "0000-01-01");
        assert_eq!(date(-719529), "-0001-12-31");
        let ts = |v: i64, unit: TimeUnit| {
            let mut out = Vec::new();
            format_timestamp(v, &unit, None, &mut out);
            String::from_utf8(out).unwrap()
        };
        assert_eq!(ts(0, TimeUnit::Second), "1970-01-01 00:00:00");
        assert_eq!(ts(-1, TimeUnit::Millisecond), "1969-12-31 23:59:59.999");
        assert_eq!(ts(1_500_000_000_123_456, TimeUnit::Microsecond), "2017-07-14 02:40:00.123456");
        assert_eq!(ts(-86400, TimeUnit::Second), "1969-12-31 00:00:00");
    }
}
