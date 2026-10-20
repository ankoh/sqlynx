//! A port of `packages/dashql-core/test/shell_prompt_buffer_test.cc`.

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
