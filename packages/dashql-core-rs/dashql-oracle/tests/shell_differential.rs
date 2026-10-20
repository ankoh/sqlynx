//! The Rust shell must behave exactly like the C++ shell (`packages/dashql-core/src/shell`).
//!
//! - `unicode`: the utf8proc render widths and grapheme breaks of every code point, of code point pairs and of
//!   random sequences.
//! - `arrow`: synthetic Arrow IPC files and streams with many types, nulls, nested values, wide and long tables
//!   and unicode, rendered at many terminal widths.
//! - `sessions`: random sessions that drive both shells through the same calls (keystrokes, edits, history,
//!   completion, dot commands, queries with synthetic results) and compare every result.
//!
//! Arrow error messages are excluded from the comparison (status only): Arrow C++ and arrow-rs word their
//! errors differently. The message of empty buffers is reproduced and compared.

use arrow_array::builder::{Int32Builder, MapBuilder, StringBuilder};
use arrow_array::types::*;
use arrow_array::*;
use arrow_buffer::{i256, Buffer, IntervalDayTime, IntervalMonthDayNano, NullBuffer, OffsetBuffer, ScalarBuffer};
use arrow_ipc::writer::{FileWriter, StreamWriter};
use arrow_schema::{DataType, Field, Fields, Schema, UnionFields};
use dashql_core::catalog::Catalog;
use dashql_core::script::Script;
use dashql_core::shell::unicode;
use dashql_core::shell::{ArrowRenderer, PromptSnapshot, SharedCatalog, Shell, ShellOperation, TerminalOutput};
use dashql_oracle::shell::{self as oracle, CxxCatalog, CxxOperation, CxxPrompt, CxxShell, CxxTerminal};
use dashql_snapshots::corpus::Rng;
use dashql_snapshots::{run, Arguments, Failed, Trial};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

fn chance(rng: &mut Rng, percent: usize) -> bool {
    rng.below(100) < percent
}

fn between(rng: &mut Rng, lo: i64, hi: i64) -> i64 {
    lo + (rng.next() % ((hi - lo + 1) as u64)) as i64
}

const STRINGS: &[&str] = &[
    "",
    "alpha",
    "界",
    "界界界 世界",
    "👩‍💻",
    "🇩🇪🇫🇷🇮🇹",
    "e\u{301}",
    "a\tb",
    "line1\nline2",
    "cr\r\nlf",
    "lonely\rcr",
    "\x01\x02\x7f",
    "safe\x1b[31mred",
    "alpha beta gamma delta epsilon zeta eta theta",
    "Ünïcödé ñ",
    "שלום עולם",
    "ﾊﾝｶｸ",
    "\u{200b}zero\u{200d}width",
    "  leading and trailing  ",
    "x",
    "42",
    "NULL",
    "a,b;c",
    "\"quoted\"",
    "very_long_identifier_without_any_spaces_that_cannot_be_wrapped_at_whitespace",
    "한국어 텍스트",
    "\u{1f600}\u{1f3fd}",
    "\u{0915}\u{094d}\u{0937}",
];

fn random_string(rng: &mut Rng) -> String {
    match rng.below(10) {
        0 => {
            let n = rng.below(5) + 1;
            (0..n).map(|_| *rng.pick(STRINGS)).collect::<Vec<_>>().join(" ")
        }
        1 => {
            let n = rng.below(30) + 1;
            (0..n).map(|i| format!("line{i}")).collect::<Vec<_>>().join("\n")
        }
        2 => "word ".repeat(rng.below(60)),
        3 => {
            let n = rng.below(20);
            (0..n).map(|_| char::from_u32(rng.below(0x2FFFF) as u32).unwrap_or('?')).collect()
        }
        _ => rng.pick(STRINGS).to_string(),
    }
}

fn random_bytes(rng: &mut Rng, max: usize) -> Vec<u8> {
    let n = rng.below(max + 1);
    (0..n).map(|_| rng.next() as u8).collect()
}

// ---------------------------------------------------------------------------
// Arrow data
// ---------------------------------------------------------------------------

fn nulls(rng: &mut Rng, n: usize, percent: usize) -> Option<NullBuffer> {
    if percent == 0 || chance(rng, 30) {
        return None;
    }
    Some(NullBuffer::from((0..n).map(|_| !chance(rng, percent)).collect::<Vec<bool>>()))
}

fn primitive<T: ArrowPrimitiveType>(rng: &mut Rng, n: usize, null_percent: usize, mut value: impl FnMut(&mut Rng) -> T::Native) -> PrimitiveArray<T> {
    let values: Vec<T::Native> = (0..n).map(|_| value(rng)).collect();
    PrimitiveArray::<T>::new(ScalarBuffer::from(values), nulls(rng, n, null_percent))
}

fn special_i64(rng: &mut Rng) -> i64 {
    match rng.below(8) {
        0 => i64::MIN,
        1 => i64::MAX,
        2 => 0,
        3 => -1,
        4 => between(rng, -100, 100),
        5 => between(rng, -10_000_000, 10_000_000),
        _ => rng.next() as i64,
    }
}

fn special_f64(rng: &mut Rng) -> f64 {
    match rng.below(14) {
        0 => f64::NAN,
        1 => f64::INFINITY,
        2 => f64::NEG_INFINITY,
        3 => 0.0,
        4 => -0.0,
        5 => f64::MIN_POSITIVE,
        6 => 5e-324,
        7 => f64::MAX,
        8 => between(rng, -1000, 1000) as f64 / 8.0,
        9 => (rng.next() as i64) as f64 / 1e6,
        10 => 10f64.powi(between(rng, -12, 12) as i32),
        11 => between(rng, -1_000_000, 1_000_000) as f64 * 10f64.powi(between(rng, -20, 20) as i32),
        _ => f64::from_bits(rng.next()),
    }
}

/// A random array of length `n` with its field
fn random_array(rng: &mut Rng, n: usize, depth: usize) -> (Field, ArrayRef) {
    let name = random_column_name(rng);
    let null_percent = *rng.pick(&[0, 10, 50, 100]);
    let kinds = if depth >= 2 { 34 } else { 44 };
    let array: ArrayRef = match rng.below(kinds) {
        0 => Arc::new(NullArray::new(n)),
        1 => Arc::new(BooleanArray::new((0..n).map(|_| chance(rng, 50)).collect(), nulls(rng, n, null_percent))),
        2 => Arc::new(primitive::<Int8Type>(rng, n, null_percent, |r| r.next() as i8)),
        3 => Arc::new(primitive::<Int16Type>(rng, n, null_percent, |r| r.next() as i16)),
        4 => Arc::new(primitive::<Int32Type>(rng, n, null_percent, |r| special_i64(r) as i32)),
        5 => Arc::new(primitive::<Int64Type>(rng, n, null_percent, special_i64)),
        6 => Arc::new(primitive::<UInt8Type>(rng, n, null_percent, |r| r.next() as u8)),
        7 => Arc::new(primitive::<UInt16Type>(rng, n, null_percent, |r| r.next() as u16)),
        8 => Arc::new(primitive::<UInt32Type>(rng, n, null_percent, |r| special_i64(r) as u32)),
        9 => Arc::new(primitive::<UInt64Type>(rng, n, null_percent, |r| special_i64(r) as u64)),
        10 => {
            let bits: Vec<u16> = (0..n).map(|_| rng.next() as u16).collect();
            Arc::new(Float16Array::new(ScalarBuffer::new(Buffer::from_vec(bits), 0, n), nulls(rng, n, null_percent)))
        }
        11 => Arc::new(primitive::<Float32Type>(rng, n, null_percent, |r| special_f64(r) as f32)),
        12 => Arc::new(primitive::<Float64Type>(rng, n, null_percent, special_f64)),
        13 => {
            let precision = between(rng, 1, 9) as u8;
            let scale = between(rng, -3, precision as i64) as i8;
            let max = 10i64.pow(precision as u32) - 1;
            Arc::new(primitive::<Decimal32Type>(rng, n, null_percent, |r| between(r, -max, max) as i32).with_precision_and_scale(precision, scale).unwrap())
        }
        14 => {
            let precision = between(rng, 1, 18) as u8;
            let scale = between(rng, -3, precision as i64) as i8;
            let max = 10i64.pow(precision as u32) - 1;
            Arc::new(primitive::<Decimal64Type>(rng, n, null_percent, |r| between(r, -max, max)).with_precision_and_scale(precision, scale).unwrap())
        }
        15 => {
            let precision = between(rng, 1, 38) as u8;
            let scale = between(rng, -5, precision as i64) as i8;
            let max = 10i128.pow(precision as u32) - 1;
            Arc::new(
                primitive::<Decimal128Type>(rng, n, null_percent, |r| ((r.next() as i128) << 64 | r.next() as i128) % (max + 1))
                    .with_precision_and_scale(precision, scale)
                    .unwrap(),
            )
        }
        16 => {
            let precision = between(rng, 1, 76) as u8;
            let scale = between(rng, -5, precision as i64) as i8;
            Arc::new(
                primitive::<Decimal256Type>(rng, n, null_percent, |r| i256::from_i128((r.next() as i128) << 32 | r.next() as i128) * i256::from_i128(r.below(1000) as i128))
                    .with_precision_and_scale(precision, scale)
                    .unwrap(),
            )
        }
        17 => Arc::new(primitive::<Date32Type>(rng, n, null_percent, |r| match r.below(4) {
            0 => r.next() as i32,
            _ => between(r, -1_000_000, 1_000_000) as i32,
        })),
        18 => Arc::new(primitive::<Date64Type>(rng, n, null_percent, |r| match r.below(4) {
            0 => special_i64(r),
            _ => between(r, -1_000_000, 1_000_000) * 86_400_000 + between(r, -86_400_000, 86_400_000),
        })),
        19 => match rng.below(2) {
            0 => Arc::new(primitive::<Time32SecondType>(rng, n, null_percent, |r| between(r, -5, 86_405) as i32)),
            _ => Arc::new(primitive::<Time32MillisecondType>(rng, n, null_percent, |r| between(r, -5, 86_400_005) as i32)),
        },
        20 => match rng.below(2) {
            0 => Arc::new(primitive::<Time64MicrosecondType>(rng, n, null_percent, |r| between(r, -5, 86_400_000_005))),
            _ => Arc::new(primitive::<Time64NanosecondType>(rng, n, null_percent, |r| between(r, -5, 86_400_000_000_005))),
        },
        21 => {
            let tz = *rng.pick(&[None, Some("UTC"), Some("+02:00"), Some("Europe/Berlin")]);
            let value = |r: &mut Rng| match r.below(3) {
                0 => special_i64(r),
                _ => between(r, -4_000_000_000, 4_000_000_000),
            };
            let array: ArrayRef = match rng.below(4) {
                0 => Arc::new(primitive::<TimestampSecondType>(rng, n, null_percent, value).with_timezone_opt(tz)),
                1 => Arc::new(primitive::<TimestampMillisecondType>(rng, n, null_percent, |r| value(r).wrapping_mul(1000)).with_timezone_opt(tz)),
                2 => Arc::new(primitive::<TimestampMicrosecondType>(rng, n, null_percent, |r| value(r).wrapping_mul(1_000_123)).with_timezone_opt(tz)),
                _ => Arc::new(primitive::<TimestampNanosecondType>(rng, n, null_percent, special_i64).with_timezone_opt(tz)),
            };
            array
        }
        22 => match rng.below(4) {
            0 => Arc::new(primitive::<DurationSecondType>(rng, n, null_percent, special_i64)),
            1 => Arc::new(primitive::<DurationMillisecondType>(rng, n, null_percent, special_i64)),
            2 => Arc::new(primitive::<DurationMicrosecondType>(rng, n, null_percent, special_i64)),
            _ => Arc::new(primitive::<DurationNanosecondType>(rng, n, null_percent, special_i64)),
        },
        23 => match rng.below(3) {
            0 => Arc::new(primitive::<IntervalYearMonthType>(rng, n, null_percent, |r| special_i64(r) as i32)),
            1 => Arc::new(primitive::<IntervalDayTimeType>(rng, n, null_percent, |r| IntervalDayTime::new(special_i64(r) as i32, special_i64(r) as i32))),
            _ => Arc::new(primitive::<IntervalMonthDayNanoType>(rng, n, null_percent, |r| {
                IntervalMonthDayNano::new(special_i64(r) as i32, special_i64(r) as i32, special_i64(r))
            })),
        },
        24..=27 => {
            let values: Vec<Option<String>> = (0..n).map(|_| if chance(rng, null_percent) { None } else { Some(random_string(rng)) }).collect();
            match rng.below(3) {
                0 => Arc::new(StringArray::from(values)),
                1 => Arc::new(LargeStringArray::from(values)),
                _ => Arc::new(StringViewArray::from(values)),
            }
        }
        28 | 29 => {
            let values: Vec<Option<Vec<u8>>> = (0..n).map(|_| if chance(rng, null_percent) { None } else { Some(random_bytes(rng, 24)) }).collect();
            let refs: Vec<Option<&[u8]>> = values.iter().map(|v| v.as_deref()).collect();
            match rng.below(3) {
                0 => Arc::new(BinaryArray::from(refs)),
                1 => Arc::new(LargeBinaryArray::from(refs)),
                _ => Arc::new(BinaryViewArray::from(refs)),
            }
        }
        30 => {
            let width = rng.below(6) + 1;
            let values: Vec<Option<Vec<u8>>> = (0..n)
                .map(|_| if chance(rng, null_percent) { None } else { Some((0..width).map(|_| rng.next() as u8).collect()) })
                .collect();
            Arc::new(FixedSizeBinaryArray::try_from_sparse_iter_with_size(values.into_iter(), width as i32).unwrap())
        }
        31 | 32 => {
            // Dictionary of strings or integers
            let dictionary_size = rng.below(25) + 1;
            let values: ArrayRef = if chance(rng, 70) {
                Arc::new(StringArray::from((0..dictionary_size).map(|_| if chance(rng, 10) { None } else { Some(random_string(rng)) }).collect::<Vec<_>>()))
            } else {
                Arc::new(primitive::<Int64Type>(rng, dictionary_size, 10, special_i64))
            };
            let keys: Vec<i32> = (0..n).map(|_| rng.below(dictionary_size) as i32).collect();
            match rng.below(3) {
                0 => Arc::new(DictionaryArray::<Int32Type>::try_new(Int32Array::new(ScalarBuffer::from(keys), nulls(rng, n, null_percent)), values).unwrap()),
                1 => Arc::new(
                    DictionaryArray::<UInt8Type>::try_new(
                        UInt8Array::new(ScalarBuffer::from(keys.iter().map(|&k| k as u8).collect::<Vec<_>>()), nulls(rng, n, null_percent)),
                        values,
                    )
                    .unwrap(),
                ),
                _ => Arc::new(
                    DictionaryArray::<Int16Type>::try_new(
                        Int16Array::new(ScalarBuffer::from(keys.iter().map(|&k| k as i16).collect::<Vec<_>>()), nulls(rng, n, null_percent)),
                        values,
                    )
                    .unwrap(),
                ),
            }
        }
        33 => {
            // Map<string, int32>
            let mut builder = MapBuilder::new(None, StringBuilder::new(), Int32Builder::new());
            for _ in 0..n {
                if chance(rng, null_percent) {
                    builder.append(false).unwrap();
                    continue;
                }
                for _ in 0..rng.below(4) {
                    builder.keys().append_value(random_string(rng));
                    if chance(rng, 20) {
                        builder.values().append_null();
                    } else {
                        builder.values().append_value(special_i64(rng) as i32);
                    }
                }
                builder.append(true).unwrap();
            }
            Arc::new(builder.finish())
        }
        34..=36 => {
            // Lists
            let lengths: Vec<usize> = (0..n).map(|_| rng.below(5)).collect();
            let total: usize = lengths.iter().sum();
            let (child_field, values) = random_array(rng, total, depth + 1);
            let child_field = Arc::new(child_field.with_name(*rng.pick(&["item", "element", "x"])).with_nullable(true));
            let list_nulls = nulls(rng, n, null_percent);
            match rng.below(2) {
                0 => Arc::new(ListArray::try_new(child_field, OffsetBuffer::from_lengths(lengths), values, list_nulls).unwrap()),
                _ => Arc::new(LargeListArray::try_new(child_field, OffsetBuffer::from_lengths(lengths), values, list_nulls).unwrap()),
            }
        }
        37 => {
            let size = rng.below(4) + 1;
            let (child_field, values) = random_array(rng, n * size, depth + 1);
            let child_field = Arc::new(child_field.with_name("item").with_nullable(true));
            Arc::new(FixedSizeListArray::try_new(child_field, size as i32, values, nulls(rng, n, null_percent)).unwrap())
        }
        38..=40 => {
            // Structs
            let count = rng.below(4) + 1;
            let mut fields = Vec::new();
            let mut arrays = Vec::new();
            for i in 0..count {
                let (field, array) = random_array(rng, n, depth + 1);
                fields.push(field.with_name(format!("{}{}", rng.pick(&["f", "Field ", "界"]), i)).with_nullable(true));
                arrays.push(array);
            }
            Arc::new(StructArray::try_new(Fields::from(fields), arrays, nulls(rng, n, null_percent)).unwrap())
        }
        _ => {
            // Sparse and dense unions
            let count = rng.below(3) + 1;
            let codes: Vec<i8> = (0..count as i8).map(|i| i * 2 + 1).collect();
            let dense = chance(rng, 50);
            let type_ids: Vec<i8> = (0..n).map(|_| *rng.pick(&codes)).collect();
            let mut fields = Vec::new();
            let mut children = Vec::new();
            let mut offsets = vec![0i32; n];
            for (c, &code) in codes.iter().enumerate() {
                let child_length = if dense {
                    let mut k = 0;
                    for (i, &t) in type_ids.iter().enumerate() {
                        if t == code {
                            offsets[i] = k;
                            k += 1;
                        }
                    }
                    k as usize
                } else {
                    n
                };
                let (field, array) = random_array(rng, child_length, depth + 1);
                fields.push(field.with_name(format!("u{c}")).with_nullable(true));
                children.push(array);
            }
            let union_fields = UnionFields::try_new(codes.clone(), fields).unwrap();
            Arc::new(
                UnionArray::try_new(union_fields, ScalarBuffer::from(type_ids), if dense { Some(ScalarBuffer::from(offsets)) } else { None }, children)
                    .unwrap(),
            )
        }
    };
    let has_nulls = array.logical_null_count() > 0 || matches!(array.data_type(), DataType::Null | DataType::Union(_, _));
    let nullable = has_nulls || chance(rng, 70);
    (Field::new(name, array.data_type().clone(), nullable), array)
}

fn random_column_name(rng: &mut Rng) -> String {
    match rng.below(6) {
        0 => random_string(rng),
        1 => format!("c{}", rng.below(100)),
        2 => "a_rather_long_column_name_for_wrapping".to_string(),
        _ => rng.pick(&["id", "name", "value", "界", "amount", "x", "description", "Col With Spaces", "tab\tname"]).to_string(),
    }
}

/// A random Arrow IPC file or stream
fn random_ipc(rng: &mut Rng, max_columns: usize, max_rows: usize) -> Vec<u8> {
    let columns = rng.below(max_columns + 1);
    let rows = match rng.below(10) {
        0 => 0,
        1 => max_rows,
        _ => rng.below(max_rows.min(12) + 1),
    };
    let mut fields = Vec::new();
    let mut arrays = Vec::new();
    for _ in 0..columns {
        let (field, array) = random_array(rng, rows, 0);
        fields.push(field);
        arrays.push(array);
    }
    let schema = Arc::new(Schema::new(fields));
    let batch = RecordBatch::try_new_with_options(schema.clone(), arrays, &RecordBatchOptions::new().with_row_count(Some(rows))).unwrap();
    // arrow-rs cannot read back sliced sparse unions, write tables with unions in one batch
    let has_union = format!("{:?}", schema).contains("Union(");
    let batches = if has_union { 1 } else { rng.below(3) + 1 };
    let mut slices = Vec::new();
    for b in 0..batches {
        let begin = rows * b / batches;
        let end = rows * (b + 1) / batches;
        slices.push(batch.slice(begin, end - begin));
    }
    if chance(rng, 10) {
        slices.clear();
    }
    if chance(rng, 50) {
        let mut writer = FileWriter::try_new(Vec::new(), &schema).unwrap();
        for slice in &slices {
            writer.write(slice).unwrap();
        }
        writer.finish().unwrap();
        writer.into_inner().unwrap()
    } else {
        let mut writer = StreamWriter::try_new(Vec::new(), &schema).unwrap();
        for slice in &slices {
            writer.write(slice).unwrap();
        }
        writer.finish().unwrap();
        writer.into_inner().unwrap()
    }
}

/// Query results: mostly valid Arrow IPC, sometimes broken
fn random_result(rng: &mut Rng) -> Vec<u8> {
    match rng.below(12) {
        0 => Vec::new(),
        1 => random_bytes(rng, 64),
        2 => {
            let mut ipc = random_ipc(rng, 3, 5);
            let cut = rng.below(ipc.len().max(1));
            ipc.truncate(cut);
            ipc
        }
        3 => random_ipc(rng, 30, 3),
        4 => random_ipc(rng, 3, 120),
        _ => random_ipc(rng, 6, 8),
    }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const ARROW_ERROR: u32 = 2;

#[derive(Default)]
struct Stats {
    comparisons: usize,
    arrow_errors: usize,
    differences: Vec<String>,
}

impl Stats {
    fn check(&mut self, what: &str, context: &dyn Fn() -> String, equal: bool, expected: String, actual: String) {
        self.comparisons += 1;
        if !equal && self.differences.len() < 10 {
            self.differences.push(format!("{what}\n{}\nC++:  {expected}\nRust: {actual}", context()));
        } else if !equal {
            self.differences.push(String::new());
        }
    }

    fn prompt(&mut self, what: &str, context: &dyn Fn() -> String, expected: &CxxPrompt, actual: &PromptSnapshot) {
        let actual = CxxPrompt {
            status: actual.status as u32,
            revision: actual.revision,
            cursor_byte_offset: actual.cursor_byte_offset,
            text: actual.text.as_bytes().to_vec(),
            message: actual.message.as_bytes().to_vec(),
            action: actual.action as u32,
        };
        self.check(what, context, *expected == actual, format!("{expected:?}"), format!("{actual:?}"));
    }

    fn terminal(&mut self, what: &str, context: &dyn Fn() -> String, expected: &CxxTerminal, actual: &TerminalOutput) {
        let actual = CxxTerminal {
            status: actual.status as u32,
            action: actual.action as u32,
            data: actual.data.clone(),
        };
        self.check(
            what,
            context,
            *expected == actual,
            format!("{} {} {:?}", expected.status, expected.action, String::from_utf8_lossy(&expected.data)),
            format!("{} {} {:?}", actual.status, actual.action, String::from_utf8_lossy(&actual.data)),
        );
    }

    fn operation(&mut self, what: &str, context: &dyn Fn() -> String, expected: &CxxOperation, actual: &ShellOperation) {
        let status = actual.status as u32;
        let equal = if expected.status == ARROW_ERROR && status == ARROW_ERROR && expected.data != b"Invalid: Arrow IPC buffer is empty" {
            self.arrow_errors += 1;
            true
        } else {
            expected.status == status && expected.data == actual.data
        };
        self.check(
            what,
            context,
            equal,
            format!("{} {:?}", expected.status, String::from_utf8_lossy(&expected.data)),
            format!("{} {:?}", status, String::from_utf8_lossy(&actual.data)),
        );
    }

    fn result(self, name: &str) -> Result<(), Failed> {
        println!("{name}: {} comparisons, {} arrow errors compared by status", self.comparisons, self.arrow_errors);
        if self.differences.is_empty() {
            return Ok(());
        }
        let shown: Vec<&String> = self.differences.iter().filter(|d| !d.is_empty()).collect();
        Err(Failed::from(format!(
            "{} differences in {} comparisons, first ones:\n\n{}",
            self.differences.len(),
            self.comparisons,
            shown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n\n")
        )))
    }
}

// ---------------------------------------------------------------------------
// Unicode
// ---------------------------------------------------------------------------

fn unicode_trial() -> Result<(), Failed> {
    let mut stats = Stats::default();
    let followers = ['a', '\u{301}', '\u{200d}', '\u{1f1e9}', '\u{1f600}', '\u{1161}', '\u{11a8}', '\n', '\r', '\u{93f}', '\u{1f3fd}'];
    let encode = |c: char| -> Vec<u8> { c.to_string().into_bytes() };
    for cp in 0..0x110000u32 {
        let Some(c) = char::from_u32(cp) else {
            continue;
        };
        let text = encode(c);
        let ctx = || format!("code point U+{cp:04X}");
        stats.check("render width", &ctx, oracle::utf8_render_width(&text, 0) == unicode::render_width_at(&text, 0), format!("{}", oracle::utf8_render_width(&text, 0)), format!("{}", unicode::render_width_at(&text, 0)));
        let follower = followers[cp as usize % followers.len()];
        let mut pair = text.clone();
        pair.extend(encode(follower));
        let expected = oracle::utf8_next_grapheme(&pair, 0);
        let actual = unicode::next_grapheme(&pair, 0);
        stats.check("next grapheme of a pair", &|| format!("U+{cp:04X} U+{:04X}", follower as u32), expected == actual, expected.to_string(), actual.to_string());
    }
    // Random sequences of interesting code points
    let interesting: Vec<char> = "a1 \t\n\r界é\u{301}\u{200d}\u{200c}\u{fe0f}\u{1f1e9}\u{1f1ea}\u{1f600}\u{1f469}\u{1f4bb}\u{1f3fd}\u{1100}\u{1161}\u{11a8}\u{ac00}\u{ac01}\u{915}\u{94d}\u{93f}\u{600}\u{e33}\u{a9}\u{2764}\u{7f}\u{1}\u{85}\u{2028}"
        .chars()
        .collect();
    let mut rng = Rng::new(0x5e11);
    for _ in 0..20000 {
        let n = rng.below(12) + 1;
        let text: String = (0..n).map(|_| *rng.pick(&interesting)).collect();
        let bytes = text.as_bytes();
        for offset in (0..bytes.len()).filter(|&i| text.is_char_boundary(i)) {
            let ctx = || format!("{text:?} at {offset}");
            let (e, a) = (oracle::utf8_next_grapheme(bytes, offset), unicode::next_grapheme(bytes, offset));
            stats.check("next grapheme", &ctx, e == a, e.to_string(), a.to_string());
            let (e, a) = (oracle::utf8_previous_grapheme(bytes, offset), unicode::previous_grapheme(bytes, offset));
            stats.check("previous grapheme", &ctx, e == a, e.to_string(), a.to_string());
        }
    }
    stats.result("unicode")
}

// ---------------------------------------------------------------------------
// Arrow rendering
// ---------------------------------------------------------------------------

fn arrow_trial(seed: u64, count: usize) -> Result<(), Failed> {
    let mut stats = Stats::default();
    let mut rng = Rng::new(seed);
    let widths = [1u32, 2, 3, 5, 8, 12, 15, 20, 33, 40, 80, 100, 173, 300];
    for i in 0..count {
        let ipc = match rng.below(20) {
            0 => random_result(&mut rng),
            1 => random_ipc(&mut rng, 40, 4),
            2 => random_ipc(&mut rng, 4, 300),
            _ => random_ipc(&mut rng, 8, 10),
        };
        for _ in 0..3 {
            let width = *rng.pick(&widths);
            let expected = oracle::render_ipc(&ipc, width);
            let actual = ArrowRenderer::new(width).render_ipc(&ipc);
            let ctx = || format!("table {i} of seed {seed:#x} at width {width}");
            match (&expected, &actual) {
                (Ok(e), Ok(a)) => stats.check("render", &ctx, e == a, String::from_utf8_lossy(e).into_owned(), String::from_utf8_lossy(a).into_owned()),
                (Err(_), Err(_)) => {
                    stats.arrow_errors += 1;
                    stats.check("render error", &ctx, true, String::new(), String::new());
                }
                _ => stats.check(
                    "render",
                    &ctx,
                    false,
                    format!("{:?}", expected.as_ref().map(|e| String::from_utf8_lossy(e).into_owned())),
                    format!("{:?}", actual.as_ref().map(|a| String::from_utf8_lossy(a).into_owned())),
                ),
            }
        }
    }
    stats.result(&format!("arrow {seed:#x}"))
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SCHEMAS: &[&str] = &[
    "CREATE TABLE orders(order_id BIGINT, customer_id BIGINT, amount DOUBLE); CREATE TABLE customers(customer_id BIGINT, name VARCHAR);",
    "CREATE TABLE \"Salesforce\".public.\"Account\"(id BIGINT, \"Name\" VARCHAR);",
    "CREATE TABLE alpha.public.accounts(id BIGINT); CREATE TABLE beta.public.accounts(id BIGINT);",
    "CREATE TABLE hyper.public.orders(id BIGINT, created DATE);",
    "CREATE TABLE uip_iceberg.cdp_usage_nonprod_events.hyperdb_queries(event_id BIGINT, processed_rows BIGINT);",
    "CREATE TABLE supplier(s_suppkey INT, s_name TEXT, s_nationkey INT); CREATE TABLE nation(n_nationkey INT, n_name TEXT);",
    "CREATE TABLE 界(列 INT, \"Spalte Ä\" TEXT);",
    "CREATE TABLE foo(only_column BIGINT);",
    "CREATE FUNCTION myfunc(a INT) RETURNS INT; CREATE TABLE events(ts TIMESTAMP, payload TEXT);",
];

const FRAGMENTS: &[&str] = &[
    "select", "SELECT", " ", " ", " ", "*", " from ", "FROM ", "orders", "customers", "o", "c", ".", "customer_id", " where ", "WHERE ", ";", ";", "\n",
    "sel", "gro", "group", " by", "acc", "Acc", "\"Account\"", "ord", "sup", "supplier", "hyperdb_quer", "q", "q.", "x.", "join ", " on ", " = ", ".help",
    ".cl", ".clear", ".timer on", ".unknown", ".", "visualize ", "'str'", "'unterminated", "-- comment\n", "/* c */", "1", "42.5", "界", "👩‍💻", "é",
    "e\u{301}", "\t", "(", ")", ",", "x", "with foo as (", "create table t (a int)", "drop table t", "insert into t values (1)", "count(", "my",
    "Salesforce", "alpha.", "beta.public.", "\u{200d}", "🇩", "🇪", "into ", "as ", "limit 10", "order by ", "o.customer_id", "c.", "n_", "s_",
    "fooo;", "SELECT 1;", "select a, b from t where x = 'y';",
];

const QUERIES: &[&str] = &[
    "SELECT 1",
    "CREATE TABLE inventory (old_id BIGINT)",
    "CREATE TABLE inventory (new_id BIGINT, quantity INTEGER)",
    "CREATE TABLE analytics.totals AS SELECT id, amount AS total FROM source",
    "CREATE TABLE source (id BIGINT, amount DOUBLE)",
    "CREATE VIEW report AS SELECT * FROM analytics.totals",
    "SELECT id AS copied_id INTO warehouse.reporting.copied FROM source",
    "DROP TABLE inventory",
    "DROP VIEW report",
    "DROP TABLE analytics.totals",
    "CREATE TABLE \"Quoted\"\"Name\" (\"a\"\"b\" INT)",
    "CREATE TABLE a (x INT); CREATE TABLE b (y INT)",
    "ATTACH DATABASE source AS attached",
    "SELECT 1 AS value VISUALIZE USING vegalite (mark => bar)",
    "select * from orders",
    "  SELECT 42; -- context\n",
    "select '界'",
    "",
];

const PROMPTS: &[&str] = &["", "dashql> ", "db> ", "hyper> ", "long-connection> ", "界> ", "no marker ", "👩‍💻>", ">"];

/// A text for prompt and terminal input
fn input_text(rng: &mut Rng) -> Vec<u8> {
    match rng.below(40) {
        0 => Vec::new(),
        1 => vec![0xff, b'a'],
        2 => random_string(rng).replace('\r', "").into_bytes(),
        3 => QUERIES[rng.below(QUERIES.len())].as_bytes().to_vec(),
        // Long prompts span several rope leaves in C++
        4 => {
            let n = rng.below(400) + 100;
            (0..n).map(|_| *rng.pick(FRAGMENTS)).collect::<String>().replace('\r', "").into_bytes()
        }
        _ => {
            let n = rng.below(3) + 1;
            (0..n).map(|_| *rng.pick(FRAGMENTS)).collect::<String>().into_bytes()
        }
    }
}

/// A key for terminal input, mostly text and keys that edit or complete
fn input_key(rng: &mut Rng) -> u32 {
    match rng.below(30) {
        0..=11 => 0,
        12 => 29 + rng.below(3) as u32,
        _ => rng.below(29) as u32,
    }
}

struct Session {
    _rust_catalog: SharedCatalog,
    _rust_schemas: Vec<Script>,
    rust: Shell,
    cxx: CxxShell,
    _cxx_catalog: CxxCatalog,
    effects: Vec<u64>,
    candidates: Vec<(String, String, u32, u32)>,
}

impl Session {
    fn new(rng: &mut Rng) -> Session {
        let rust_catalog: SharedCatalog = Rc::new(RefCell::new(Catalog::new()));
        let mut cxx_catalog = CxxCatalog::new();
        let mut schemas = Vec::new();
        for _ in 0..rng.below(4) {
            let text = *rng.pick(SCHEMAS);
            let rank = rng.below(3) as u32;
            let mut script = Script::new(&rust_catalog.borrow());
            script.insert_text_at(0, text);
            let loaded = script.analyze(&rust_catalog.borrow(), true).is_ok()
                && rust_catalog.borrow_mut().load_script(script.analyzed.clone().unwrap(), rank).is_ok();
            assert_eq!(loaded, cxx_catalog.load_script(text, rank), "schema {text}");
            schemas.push(script);
        }
        let columns = *rng.pick(&[1u32, 2, 4, 8, 12, 16, 20, 40, 80, 100, 160, 173]);
        let auto_qualify = chance(rng, 40);
        let rust = Shell::new(rust_catalog.clone(), columns, auto_qualify);
        let cxx = CxxShell::new(&cxx_catalog, columns, auto_qualify);
        Session {
            _rust_catalog: rust_catalog,
            _rust_schemas: schemas,
            rust,
            cxx,
            _cxx_catalog: cxx_catalog,
            effects: Vec::new(),
            candidates: Vec::new(),
        }
    }

    fn remember_effect(&mut self, operation: &CxxOperation) {
        if operation.status == 4 && operation.data.len() >= 16 {
            self.effects.push(u64::from_le_bytes(operation.data[8..16].try_into().unwrap()));
        }
    }

    fn step(&mut self, rng: &mut Rng, stats: &mut Stats, ctx: &dyn Fn() -> String) {
        match rng.below(100) {
            0..=44 => {
                let key = input_key(rng);
                let text = if key == 0 { input_text(rng) } else if chance(rng, 5) { input_text(rng) } else { Vec::new() };
                let e = self.cxx.terminal_consume(key, &text);
                let a = self.rust.terminal_consume(key, &text);
                stats.terminal(&format!("terminal_consume({key}, {:?})", String::from_utf8_lossy(&text)), ctx, &e, &a);
            }
            45..=52 => {
                let key = input_key(rng);
                let text = if key == 0 { input_text(rng) } else { Vec::new() };
                let e = self.cxx.prompt_consume(key, &text);
                let a = self.rust.prompt_consume(key, &text);
                stats.prompt(&format!("prompt_consume({key}, {:?})", String::from_utf8_lossy(&text)), ctx, &e, &a);
            }
            53..=55 => {
                let text = input_text(rng);
                let (e, a) = if chance(rng, 50) { (self.cxx.prompt_set(&text), self.rust.prompt_set(&text)) } else { (self.cxx.prompt_insert(&text), self.rust.prompt_insert(&text)) };
                stats.prompt(&format!("prompt_set/insert({:?})", String::from_utf8_lossy(&text)), ctx, &e, &a);
            }
            56..=59 => {
                let (e, a) = match rng.below(4) {
                    0 => (self.cxx.prompt_move_left(), self.rust.prompt_move_left()),
                    1 => (self.cxx.prompt_move_right(), self.rust.prompt_move_right()),
                    2 => (self.cxx.prompt_delete_backward(), self.rust.prompt_delete_backward()),
                    _ => (self.cxx.prompt_delete_forward(), self.rust.prompt_delete_forward()),
                };
                stats.prompt("prompt move/delete", ctx, &e, &a);
            }
            60..=65 => {
                // A limit of 0 fails an assertion of the C++ TopKHeap
                let limit = *rng.pick(&[1usize, 3, 10, 50]);
                let e = self.cxx.prompt_complete(limit);
                let a = self.rust.prompt_complete(limit);
                let e_cmp = e.clone().map(|cs| cs.into_iter().map(|c| (c.display_text, c.completion_text, c.target_offset, c.target_length)).collect::<Vec<_>>());
                let a_cmp = a.clone().map(|cs| cs.into_iter().map(|c| (c.display_text.into_bytes(), c.completion_text.into_bytes(), c.target_offset, c.target_length)).collect::<Vec<_>>());
                let a_status = a_cmp.as_ref().map_err(|s| *s as u32).map(|v| v.clone());
                stats.check(&format!("prompt_complete({limit})"), ctx, e_cmp == a_status, format!("{e_cmp:?}"), format!("{a_status:?}"));
                self.candidates = a
                    .unwrap_or_default()
                    .into_iter()
                    .map(|c| (c.display_text, c.completion_text, c.target_offset, c.target_length))
                    .collect();
            }
            66..=67 => {
                let (display, completion, offset, length) = if !self.candidates.is_empty() && chance(rng, 70) {
                    let (d, c, o, l) = self.candidates[rng.below(self.candidates.len())].clone();
                    (d.into_bytes(), c.into_bytes(), o, l)
                } else {
                    (input_text(rng), input_text(rng), rng.below(12) as u32, rng.below(5) as u32)
                };
                let e = self.cxx.prompt_apply_completion(&display, &completion, offset, length);
                let a = self.rust.prompt_apply_completion(&display, &completion, offset, length);
                stats.prompt(&format!("prompt_apply_completion({:?}, {offset}, {length})", String::from_utf8_lossy(&completion)), ctx, &e, &a);
            }
            68..=72 => {
                let e = self.cxx.prompt_submit();
                let a = self.rust.prompt_submit();
                stats.operation("prompt_submit", ctx, &e, &a);
                self.remember_effect(&e);
            }
            73..=75 => {
                let query = if chance(rng, 80) { QUERIES[rng.below(QUERIES.len())].as_bytes().to_vec() } else { input_text(rng) };
                let e = self.cxx.start_query(&query);
                let a = self.rust.start_query(&query);
                stats.operation(&format!("start_query({:?})", String::from_utf8_lossy(&query)), ctx, &e, &a);
                self.remember_effect(&e);
            }
            76..=82 => {
                let id = if !self.effects.is_empty() && chance(rng, 85) { self.effects.remove(rng.below(self.effects.len())) } else { rng.below(6) as u64 };
                if chance(rng, 15) {
                    let e = self.cxx.cancel_effect(id);
                    let a = self.rust.cancel_effect(id);
                    stats.operation(&format!("cancel_effect({id})"), ctx, &e, &a);
                } else {
                    let status = *rng.pick(&[0u32, 0, 0, 0, 1, 2, 3]);
                    let data = match rng.below(6) {
                        0 => input_text(rng),
                        1 => {
                            let mut d = vec![rng.next() as u8];
                            d.extend(input_text(rng));
                            d
                        }
                        _ => random_result(rng),
                    };
                    let e = self.cxx.complete_effect(id, status, &data);
                    let a = self.rust.complete_effect(id, status, &data);
                    stats.operation(&format!("complete_effect({id}, {status}, {} bytes)", data.len()), ctx, &e, &a);
                }
            }
            83..=85 => {
                let prompt = if chance(rng, 90) {
                    rng.pick(PROMPTS).as_bytes().to_vec()
                } else if chance(rng, 50) {
                    "x".repeat(250 + rng.below(10)).into_bytes()
                } else {
                    vec![0xc3, 0x28]
                };
                let e = self.cxx.terminal_open(&prompt);
                let a = self.rust.terminal_open(&prompt);
                stats.terminal(&format!("terminal_open({:?})", String::from_utf8_lossy(&prompt)), ctx, &e, &a);
            }
            86..=88 => {
                let output = if chance(rng, 50) { random_string(rng).into_bytes() } else { input_text(rng) };
                let error = chance(rng, 30);
                let e = self.cxx.terminal_finish_query(&output, error);
                let a = self.rust.terminal_finish_query(&output, error);
                stats.terminal("terminal_finish_query", ctx, &e, &a);
            }
            89..=91 => {
                let (e, a) = match rng.below(3) {
                    0 => {
                        let message = if chance(rng, 50) { random_string(rng).into_bytes() } else { input_text(rng) };
                        let advance = chance(rng, 50);
                        (self.cxx.terminal_query_progress(&message, advance), self.rust.terminal_query_progress(&message, advance))
                    }
                    1 => (self.cxx.terminal_query_progress_clear(), self.rust.terminal_query_progress_clear()),
                    _ => {
                        let message = random_string(rng).into_bytes();
                        (self.cxx.terminal_status(&message), self.rust.terminal_status(&message))
                    }
                };
                stats.terminal("terminal progress/status", ctx, &e, &a);
            }
            92 => {
                let columns = *rng.pick(&[1u32, 3, 8, 12, 20, 40, 80, 100, 173]);
                self.cxx.resize(columns);
                self.rust.resize(columns);
            }
            93 => {
                let case = *rng.pick(&[0u32, 1, 1, 2, 257]);
                self.cxx.set_keyword_case(case);
                self.rust.set_keyword_case(case);
            }
            94 => {
                let enabled = chance(rng, 70);
                let e = self.cxx.set_session_relations(enabled);
                let a = self.rust.set_session_relations(enabled) as u32;
                stats.check("set_session_relations", ctx, e == a, e.to_string(), a.to_string());
            }
            95 => {
                let options: [&[u8]; 7] = [b"clear\ntimer\nhelp", b"clear\nhelp\nlogin\nrefresh", b"", b"Bad", b"a\n\nb", b".x", b"ok-name_1"];
                let commands = *rng.pick(&options);
                let e = self.cxx.set_commands(commands);
                let a = self.rust.set_commands(commands) as u32;
                stats.check("set_commands", ctx, e == a, e.to_string(), a.to_string());
            }
            _ => {
                let e = self.cxx.history_export();
                let a = self.rust.history_export();
                stats.check("history_export", ctx, e.status == 0 && e.data == a, format!("{:?}", e), format!("{:?}", a));
                let data = match rng.below(4) {
                    0 => random_bytes(rng, 16),
                    1 => Vec::new(),
                    _ => {
                        let mut d = e.data.clone();
                        for _ in 0..rng.below(3) {
                            let entry = input_text(rng);
                            d.extend((entry.len() as u32).to_le_bytes());
                            d.extend(entry);
                        }
                        d
                    }
                };
                let e = self.cxx.history_import(&data);
                let a = self.rust.history_import(&data) as u32;
                stats.check("history_import", ctx, e.status == a && e.data.is_empty(), format!("{e:?}"), a.to_string());
            }
        }
    }
}

fn session_trial(seed: u64, sessions: usize, steps: usize) -> Result<(), Failed> {
    let mut stats = Stats::default();
    for s in 0..sessions {
        let session_seed = seed.wrapping_mul(1000).wrapping_add(s as u64);
        let mut rng = Rng::new(session_seed);
        let mut session = Session::new(&mut rng);
        if chance(&mut rng, 70) {
            let commands = b"clear\ntimer\nhelp";
            assert_eq!(session.cxx.set_commands(commands), session.rust.set_commands(commands) as u32);
        }
        if chance(&mut rng, 40) {
            let (e, a) = (session.cxx.set_session_relations(true), session.rust.set_session_relations(true) as u32);
            assert_eq!(e, a);
        }
        if chance(&mut rng, 30) {
            session.cxx.set_keyword_case(1);
            session.rust.set_keyword_case(1);
        }
        let prompt = rng.pick(PROMPTS).as_bytes().to_vec();
        let (e, a) = (session.cxx.terminal_open(&prompt), session.rust.terminal_open(&prompt));
        stats.terminal("terminal_open", &|| format!("session {session_seed}"), &e, &a);
        for step in 0..steps {
            let before = stats.differences.len();
            session.step(&mut rng, &mut stats, &|| format!("session {session_seed}, step {step}"));
            if stats.differences.len() > before {
                break;
            }
        }
        // The session relations leave the catalog when the shell is destroyed
        drop(session);
    }
    stats.result(&format!("sessions {seed:#x}"))
}

fn main() {
    let args = Arguments::from_args();
    let mut trials = vec![Trial::test("unicode", unicode_trial)];
    for seed in 0..8u64 {
        trials.push(Trial::test(format!("arrow::{seed}"), move || arrow_trial(0xa770 + seed, 1000)));
    }
    for seed in 0..16u64 {
        trials.push(Trial::test(format!("sessions::{seed}"), move || session_trial(0x5e55 + seed, 100, 150)));
    }
    run(&args, trials).exit();
}
