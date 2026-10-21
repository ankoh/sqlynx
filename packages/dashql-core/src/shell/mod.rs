//! The DashQL shell (the C++ `src/shell`): a readline-like prompt with SQL
//! highlighting and completion, a VT100 terminal renderer, and the execution protocol of queries
//! and dot commands.
//!
//! The C++ shell runs queries and commands as coroutines that suspend on an effect. Here they are
//! explicit pending effects with the same protocol: starting an operation returns
//! [`ShellStatus::Pending`] with an effect envelope (version, type, id, payload), and the host
//! completes or cancels the effect by id, which yields the rendered output.
//!
//! The session does not own its catalog. Operations that read it take `&Catalog`, operations that
//! may publish session relations take `&mut Catalog` (see [`ShellSession`]).
//!
//! Inputs that C++ validates as UTF-8 are byte slices so that invalid input fails like in C++, and
//! outputs are terminal bytes.

pub mod api;
pub mod arrow_renderer;
pub mod prompt_buffer;
mod session;
pub mod session_relations;
pub mod unicode;
pub mod vt100;

pub use api::{SharedCatalog, Shell};
pub use arrow_renderer::ArrowRenderer;
pub use prompt_buffer::PromptBuffer;
pub use session::ShellSession;

/// The status of a shell operation (`DashQLShellStatus`)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum ShellStatus {
    Ok = 0,
    InvalidArgument = 1,
    ArrowError = 2,
    InternalError = 3,
    Pending = 4,
    StaleEffect = 5,
    Busy = 6,
}

/// The type of an effect (`EffectType`)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum EffectType {
    ExecuteQuery = 1,
    ExecuteCommand = 2,
}

/// How the host finished an effect (`DashQLShellEffectCompletionStatus`)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum EffectCompletionStatus {
    Success = 0,
    Error = 1,
    Cancelled = 2,
}

impl EffectCompletionStatus {
    pub fn from_u32(value: u32) -> Option<Self> {
        Some(match value {
            0 => Self::Success,
            1 => Self::Error,
            2 => Self::Cancelled,
            _ => return None,
        })
    }
}

/// A semantic input key (`DashQLShellPromptInputKey`)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum PromptInputKey {
    Text = 0,
    Enter = 1,
    ForceSubmit = 2,
    Tab = 3,
    Backspace = 4,
    Delete = 5,
    Left = 6,
    Right = 7,
    HistoryPrevious = 8,
    HistoryNext = 9,
    Cancel = 10,
    Escape = 11,
    Up = 12,
    Down = 13,
    Start = 14,
    End = 15,
    LineStart = 16,
    LineEnd = 17,
    WordLeft = 18,
    WordRight = 19,
    KillLine = 20,
    BackwardKillLine = 21,
    KillWord = 22,
    BackwardKillWord = 23,
    Yank = 24,
    Transpose = 25,
    ClearScreen = 26,
    Eof = 27,
    Abort = 28,
}

impl PromptInputKey {
    pub const ALL: [PromptInputKey; 29] = [
        Self::Text,
        Self::Enter,
        Self::ForceSubmit,
        Self::Tab,
        Self::Backspace,
        Self::Delete,
        Self::Left,
        Self::Right,
        Self::HistoryPrevious,
        Self::HistoryNext,
        Self::Cancel,
        Self::Escape,
        Self::Up,
        Self::Down,
        Self::Start,
        Self::End,
        Self::LineStart,
        Self::LineEnd,
        Self::WordLeft,
        Self::WordRight,
        Self::KillLine,
        Self::BackwardKillLine,
        Self::KillWord,
        Self::BackwardKillWord,
        Self::Yank,
        Self::Transpose,
        Self::ClearScreen,
        Self::Eof,
        Self::Abort,
    ];

    /// The key of a C ABI value, None for values past `ABORT`
    pub fn from_u32(value: u32) -> Option<Self> {
        Self::ALL.get(value as usize).copied()
    }
}

/// What the host should do after an input (`DashQLShellPromptInputAction`)
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum PromptInputAction {
    #[default]
    None = 0,
    Submit = 1,
    Complete = 2,
    Exit = 3,
}

/// The result of an operation: rendered output, an effect envelope or an error message (`ShellOperation`)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellOperation {
    /// The status of the operation
    pub status: ShellStatus,
    /// The rendered output, the encoded effect envelope or the error message
    pub data: Vec<u8>,
}

impl ShellOperation {
    pub fn new(status: ShellStatus, data: impl Into<Vec<u8>>) -> Self {
        Self { status, data: data.into() }
    }

    pub fn ok(data: impl Into<Vec<u8>>) -> Self {
        Self::new(ShellStatus::Ok, data)
    }
}

/// Terminal output with the action of the input (`DashQLShellTerminalResult`)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalOutput {
    /// The status of the input
    pub status: ShellStatus,
    /// What the host should do after the input
    pub action: PromptInputAction,
    /// The terminal output with VT100 escape sequences, or the error message
    pub data: Vec<u8>,
}

/// A completion candidate of the prompt (`CompletionCandidate`)
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CompletionCandidate {
    /// The text shown in the completion list
    pub display_text: String,
    /// The text that replaces the target, quoted if needed and with `()` for functions
    pub completion_text: String,
    /// The keywords that usually follow the completion, shown as hint, empty if none
    pub continuation_text: String,
    /// Whether this candidate only preserves the token already under the cursor
    pub is_identity: bool,
    /// The qualified names of the candidate objects that are shown as variants
    pub qualification_texts: Vec<String>,
    /// The cursor offset within the completion text after applying it
    pub completion_cursor_offset: u32,
    /// The byte offset of the replaced text in the prompt
    pub target_offset: u32,
    /// The byte length of the replaced text in the prompt
    pub target_length: u32,
    /// The byte offset of the text that a qualified name replaces
    pub qualification_target_offset: u32,
    /// The byte length of the text that a qualified name replaces
    pub qualification_target_length: u32,
}

/// The state of the prompt after an edit (`PromptSnapshot`)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptSnapshot {
    /// The status of the edit
    pub status: ShellStatus,
    /// The revision of the prompt text
    pub revision: u64,
    /// The byte offset of the cursor in the text
    pub cursor_byte_offset: u32,
    /// The prompt text
    pub text: String,
    /// The error message, empty on success
    pub message: String,
    /// What the host should do after the edit
    pub action: PromptInputAction,
}

/// The version of the effect envelope
pub const EFFECT_ENVELOPE_VERSION: u32 = 1;
/// The size of the effect envelope header: version (u32), type (u32), id (u64), all little-endian
pub const EFFECT_ENVELOPE_HEADER_SIZE: usize = 16;
