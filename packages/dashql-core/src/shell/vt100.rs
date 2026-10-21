//! VT100 control sequences of the shell (`include/dashql/shell/vt100.h`).

pub const CONTROL_SEQUENCE_INTRODUCER: &str = "\x1b[";
pub const CARRIAGE_RETURN: &str = "\r";
pub const NEW_LINE: &str = "\r\n";

/// Parameterized CSI commands
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Command {
    InsertCharacter = b'@',
    CursorUp = b'A',
    CursorDown = b'B',
    CursorForward = b'C',
    CursorBackward = b'D',
    InsertLine = b'L',
    DeleteLine = b'M',
    DeleteCharacter = b'P',
}

/// Append a parameterized CSI command (`AppendSequence`)
pub fn append_sequence(output: &mut Vec<u8>, count: usize, command: Command) {
    output.extend_from_slice(CONTROL_SEQUENCE_INTRODUCER.as_bytes());
    output.extend_from_slice(count.to_string().as_bytes());
    output.push(command as u8);
}

/// A parameterized CSI command (`Sequence`)
pub fn sequence(count: usize, command: Command) -> String {
    let mut output = Vec::new();
    append_sequence(&mut output, count, command);
    String::from_utf8(output).unwrap()
}

pub const CURSOR_UP_ONE: &str = "\x1b[1A";
pub const ERASE_ENTIRE_LINE: &str = "\x1b[2K";
pub const ERASE_LINE_FROM_CURSOR: &str = "\x1b[0K";
pub const SAVE_CURSOR: &str = "\x1b[s";
pub const RESTORE_CURSOR: &str = "\x1b[u";
pub const ENABLE_AUTO_WRAP: &str = "\x1b[?7h";
pub const DISABLE_AUTO_WRAP: &str = "\x1b[?7l";
pub const CLEAR_SCREEN: &str = "\x1b[2J\x1b[H";

pub const RESET_ATTRIBUTES: &str = "\x1b[0m";
pub const BOLD: &str = "\x1b[1m";
pub const REVERSE_VIDEO: &str = "\x1b[7m";
pub const FOREGROUND_RED: &str = "\x1b[31m";
pub const FOREGROUND_BRIGHT_BLACK: &str = "\x1b[90m";
pub const BOLD_FOREGROUND_PINK: &str = "\x1b[1;38;2;255;122;178m";
pub const ITALIC_FOREGROUND_SILVER: &str = "\x1b[3;38;2;201;209;217m";
pub const FOREGROUND_PURPLE: &str = "\x1b[38;2;218;186;255m";
pub const FOREGROUND_CORAL: &str = "\x1b[38;2;255;129;112m";
pub const FOREGROUND_PINK: &str = "\x1b[38;2;255;122;178m";
pub const FOREGROUND_SILVER: &str = "\x1b[38;2;201;209;217m";
pub const FOREGROUND_GRAY: &str = "\x1b[38;2;127;140;152m";
