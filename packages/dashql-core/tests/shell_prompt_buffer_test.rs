//! A port of the C++ `test/shell_prompt_buffer_test.cc`.

use dashql_core::catalog::Catalog;
use dashql_core::shell::PromptBuffer;

fn prompt() -> PromptBuffer {
    PromptBuffer::new(&Catalog::new())
}

#[test]
fn sets_valid_utf8_and_rejects_invalid_utf8() {
    let mut prompt = prompt();
    assert!(prompt.set_text("select 界".as_bytes()));
    assert_eq!(prompt.text(), "select 界");
    assert_eq!(prompt.cursor_byte_offset(), prompt.text().len());
    assert_eq!(prompt.cursor_codepoint_offset(), 8);
    assert_eq!(prompt.grapheme_count(), 8);
    assert_eq!(prompt.revision(), 1);

    assert!(!prompt.set_text(b"\xc3\x28"));
    assert_eq!(prompt.text(), "select 界");
    assert_eq!(prompt.revision(), 1);
}

#[test]
fn moves_across_extended_grapheme_clusters() {
    let mut prompt = prompt();
    assert!(prompt.set_text("a👩‍💻é".as_bytes()));
    let end = prompt.text().len();

    assert!(prompt.move_left());
    assert_eq!(prompt.cursor_byte_offset(), end - "é".len());
    assert!(prompt.move_left());
    assert_eq!(prompt.cursor_byte_offset(), 1);
    assert!(prompt.move_left());
    assert_eq!(prompt.cursor_byte_offset(), 0);
    assert!(!prompt.move_left());

    assert!(prompt.move_right());
    assert_eq!(prompt.cursor_byte_offset(), 1);
    assert!(prompt.move_right());
    assert_eq!(prompt.cursor_byte_offset(), end - "é".len());
    assert!(prompt.move_right());
    assert_eq!(prompt.cursor_byte_offset(), end);
    assert!(!prompt.move_right());
}

#[test]
fn moves_to_prompt_start_and_end() {
    let mut prompt = prompt();
    assert!(prompt.set_text("a👩‍💻é".as_bytes()));

    assert!(prompt.move_to_start());
    assert_eq!(prompt.cursor_byte_offset(), 0);
    assert!(!prompt.move_to_start());

    assert!(prompt.move_to_end());
    assert_eq!(prompt.cursor_byte_offset(), prompt.text().len());
    assert!(!prompt.move_to_end());
}

#[test]
fn moves_to_line_and_word_boundaries() {
    let mut prompt = prompt();
    assert!(prompt.set_text("first line\nalpha_2 界 beta".as_bytes()));

    assert!(prompt.move_to_line_start());
    assert_eq!(prompt.cursor_byte_offset(), "first line\n".len());
    assert!(prompt.move_word_right());
    assert_eq!(prompt.cursor_byte_offset(), "first line\nalpha_2".len());
    assert!(prompt.move_word_right());
    assert_eq!(prompt.cursor_byte_offset(), "first line\nalpha_2 界".len());
    assert!(prompt.move_word_left());
    assert_eq!(prompt.cursor_byte_offset(), "first line\nalpha_2 ".len());
    assert!(prompt.move_to_line_end());
    assert_eq!(prompt.cursor_byte_offset(), prompt.text().len());
}

#[test]
fn moves_vertically_across_lines_by_grapheme_column() {
    let mut prompt = prompt();
    assert!(prompt.set_text("ab界\nx\n1234".as_bytes()));

    assert!(prompt.move_up());
    assert_eq!(prompt.cursor_byte_offset(), "ab界\nx".len());
    assert!(prompt.move_up());
    assert_eq!(prompt.cursor_byte_offset(), 1);
    assert!(!prompt.move_up());

    assert!(prompt.move_down());
    assert_eq!(prompt.cursor_byte_offset(), "ab界\nx".len());
    assert!(prompt.move_down());
    assert_eq!(prompt.cursor_byte_offset(), "ab界\nx\n1".len());
    assert!(!prompt.move_down());
}

#[test]
fn inserts_and_deletes_whole_grapheme_clusters() {
    let mut prompt = prompt();
    assert!(prompt.set_text(b"ac"));
    assert!(prompt.move_left());

    assert!(prompt.insert("👩‍💻".as_bytes()));
    assert_eq!(prompt.text(), "a👩‍💻c");
    assert_eq!(prompt.revision(), 2);

    assert!(prompt.delete_backward());
    assert_eq!(prompt.text(), "ac");
    assert_eq!(prompt.cursor_byte_offset(), 1);
    assert_eq!(prompt.revision(), 3);

    assert!(prompt.delete_forward());
    assert_eq!(prompt.text(), "a");
    assert_eq!(prompt.cursor_byte_offset(), 1);
    assert_eq!(prompt.revision(), 4);
    assert!(!prompt.delete_forward());
    assert_eq!(prompt.revision(), 4);
}

#[test]
fn kills_and_transposes_at_grapheme_boundaries() {
    let mut prompt = prompt();
    assert!(prompt.set_text("one two\n👩‍💻界x".as_bytes()));
    assert!(prompt.move_to_line_start());

    let mut killed = String::new();
    assert!(prompt.delete_word_forward(Some(&mut killed)));
    assert_eq!(killed, "👩‍💻界x");
    assert_eq!(prompt.text(), "one two\n");
    assert!(prompt.insert("a界".as_bytes()));
    assert!(prompt.transpose_characters());
    assert_eq!(prompt.text(), "one two\n界a");

    assert!(prompt.delete_to_line_start(Some(&mut killed)));
    assert_eq!(killed, "界a");
    assert_eq!(prompt.text(), "one two\n");
    assert!(prompt.move_to_start());
    assert!(prompt.move_word_right());
    assert!(prompt.delete_word_backward(Some(&mut killed)));
    assert_eq!(killed, "one");
    assert_eq!(prompt.text(), " two\n");
    assert!(prompt.delete_to_line_end(Some(&mut killed)));
    assert_eq!(killed, " two");
    assert_eq!(prompt.text(), "\n");
    assert!(prompt.delete_to_line_end(Some(&mut killed)));
    assert_eq!(killed, "\n");
    assert!(prompt.text().is_empty());
}

#[test]
fn keeps_cursor_on_boundary_when_insertion_joins_graphemes() {
    let mut prompt = prompt();
    assert!(prompt.set_text("👩💻".as_bytes()));
    assert!(prompt.move_left());

    assert!(prompt.insert("\u{200d}".as_bytes()));
    assert_eq!(prompt.text(), "👩‍💻");
    assert_eq!(prompt.grapheme_count(), 1);
    assert_eq!(prompt.cursor_byte_offset(), prompt.text().len());

    assert!(prompt.delete_backward());
    assert!(prompt.text().is_empty());
}

#[test]
fn only_moves_cursor_to_grapheme_boundaries() {
    let mut prompt = prompt();
    assert!(prompt.set_text("界x".as_bytes()));

    assert!(!prompt.move_to_byte_offset(1));
    assert_eq!(prompt.cursor_byte_offset(), prompt.text().len());
    assert!(prompt.move_to_byte_offset("界".len()));
    assert_eq!(prompt.cursor_byte_offset(), "界".len());
    assert_eq!(prompt.revision(), 1);
}

#[test]
fn empty_edits_do_not_advance_revision() {
    let mut prompt = prompt();
    assert_eq!(prompt.grapheme_count(), 0);
    assert!(!prompt.insert(b""));
    assert!(!prompt.delete_backward());
    assert!(!prompt.delete_forward());
    assert_eq!(prompt.revision(), 0);

    assert!(prompt.set_text(b""));
    assert_eq!(prompt.revision(), 0);
    assert!(!prompt.insert(b"\xff"));
    assert_eq!(prompt.revision(), 0);

    assert!(prompt.set_text(b"x"));
    assert_eq!(prompt.revision(), 1);
    assert!(prompt.set_text(b"x"));
    assert_eq!(prompt.revision(), 1);
}

#[test]
fn exposes_the_script_of_the_prompt() {
    let mut prompt = prompt();
    assert!(prompt.set_text(b"select 1"));
    assert_eq!(prompt.script().to_text(), "select 1");
}

#[test]
fn line_kills_stop_at_line_boundaries_and_report_no_ops() {
    let mut prompt = prompt();
    assert!(prompt.set_text(b"one\ntwo"));
    let mut killed = String::new();
    // At the end of the text there is nothing after the cursor
    assert!(!prompt.delete_to_line_end(Some(&mut killed)));
    assert!(prompt.delete_to_line_start(Some(&mut killed)));
    assert_eq!(killed, "two");
    assert_eq!(prompt.text(), "one\n");
    // Directly behind a line break there is nothing before the cursor
    assert!(!prompt.delete_to_line_start(Some(&mut killed)));

    // A kill at the end of a line removes the line break
    assert!(prompt.set_text(b"one\ntwo"));
    assert!(prompt.move_to_start());
    assert!(prompt.move_to_line_end());
    assert!(prompt.delete_to_line_end(Some(&mut killed)));
    assert_eq!(killed, "\n");
    assert_eq!(prompt.text(), "onetwo");
}

#[test]
fn word_kills_report_no_ops_at_the_boundaries() {
    let mut prompt = prompt();
    assert!(prompt.set_text(b"alpha beta"));
    let mut killed = String::new();
    assert!(!prompt.delete_word_forward(Some(&mut killed)));
    assert!(prompt.delete_word_backward(Some(&mut killed)));
    assert_eq!(killed, "beta");
    assert!(prompt.move_to_start());
    assert!(!prompt.delete_word_backward(Some(&mut killed)));
    assert!(prompt.delete_word_forward(Some(&mut killed)));
    assert_eq!(killed, "alpha");
    assert_eq!(prompt.text(), " ");
}

#[test]
fn word_movement_skips_separators() {
    let mut prompt = prompt();
    assert!(prompt.set_text(b"a, b  c"));
    assert!(prompt.move_word_left());
    assert_eq!(prompt.cursor_byte_offset(), 6);
    assert!(prompt.move_word_left());
    assert_eq!(prompt.cursor_byte_offset(), 3);
    assert!(prompt.move_word_left());
    assert_eq!(prompt.cursor_byte_offset(), 0);
    assert!(!prompt.move_word_left());
    assert!(prompt.move_word_right());
    assert_eq!(prompt.cursor_byte_offset(), 1);
}

#[test]
fn transpose_needs_two_graphemes_before_the_cursor() {
    let mut prompt = prompt();
    assert!(prompt.set_text(b"a"));
    assert!(!prompt.transpose_characters());
    assert!(prompt.set_text(b"ab"));
    assert!(prompt.move_to_start());
    assert!(!prompt.transpose_characters());
    assert!(prompt.move_to_end());
    assert!(prompt.transpose_characters());
    assert_eq!(prompt.text(), "ba");
}

#[test]
fn replaces_byte_ranges_with_validated_text() {
    let mut prompt = prompt();
    assert!(prompt.set_text("select 界".as_bytes()));
    assert!(prompt.replace_byte_range_bytes(0, 6, b"SELECT"));
    assert_eq!(prompt.text(), "SELECT 界");
    // Invalid UTF-8 and ranges inside of a code point are rejected
    assert!(!prompt.replace_byte_range_bytes(0, 6, b"\xff"));
    assert!(!prompt.replace_byte_range(8, 1, "x"));
    assert!(!prompt.replace_byte_range(1000, 1, "x"));
    assert_eq!(prompt.text(), "SELECT 界");
}

#[test]
fn measures_display_width_of_text() {
    use dashql_core::shell::unicode::{display_width, graphemes, is_valid, next_grapheme, previous_grapheme};
    assert_eq!(display_width(b"abc"), 3);
    assert_eq!(display_width("界".as_bytes()), 2);
    assert_eq!(display_width("e\u{301}".as_bytes()), 1);
    // Control characters take no cells
    assert_eq!(display_width(b"\x01"), 0);
    // Invalid UTF-8 counts bytes
    assert_eq!(display_width(b"\xff\xfe"), 2);
    assert_eq!(graphemes(b"\xffa"), vec![(0, 1), (1, 2)]);
    assert_eq!(graphemes("a界".as_bytes()), vec![(0, 1), (1, 4)]);
    assert!(is_valid("界".as_bytes()));
    assert!(!is_valid(b"\xc3"));
    assert_eq!(next_grapheme("a👩‍💻b", 1), 12);
    assert_eq!(previous_grapheme("a👩‍💻b", 12), 1);
}
