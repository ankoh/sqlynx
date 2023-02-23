use flatsql_proto as proto;
use std::error::Error;

pub type DeleterPtr = extern "C" fn(*mut cty::c_void);

pub extern "C" fn flatsql_parser_noop_deleter(_data: *mut cty::c_void) {}

#[repr(C)]
struct FFIResult {
    status_code: cty::uint32_t,
    data_length: cty::uint32_t,
    data_ptr: *mut cty::c_void,
    owner_ptr: *mut cty::c_void,
    owner_deleter: DeleterPtr,
}

#[link(name = "flatsql_parser")]
extern "C" {
    fn flatsql_parse(result: *mut FFIResult, text: *const u8, text_length: cty::size_t) -> ();
}

pub struct ProgramBuffer {
    data_length: cty::uint32_t,
    data_ptr: *const u8,
    owner_ptr: *mut cty::c_void,
    owner_deleter: DeleterPtr,
}

impl Drop for ProgramBuffer {
    fn drop(&mut self) {
        let ptr = self.owner_ptr;
        if ptr != std::ptr::null_mut() {
            (self.owner_deleter)(self.owner_ptr);
        }
        self.owner_ptr = std::ptr::null_mut();
    }
}

impl ProgramBuffer {
    pub fn access<'a>(&'a self) -> &'a [u8] {
        unsafe { std::slice::from_raw_parts(self.data_ptr, self.data_length as usize) }
    }
}

pub fn parse(text: &str) -> Result<ProgramBuffer, String> {
    let mut result = FFIResult {
        status_code: 0,
        data_length: 0,
        data_ptr: std::ptr::null_mut(),
        owner_ptr: std::ptr::null_mut(),
        owner_deleter: flatsql_parser_noop_deleter,
    };
    // Zero-pad input that is passed to the parser function.
    let mut text_buffer = text.as_bytes().to_vec();
    text_buffer.push(0);
    text_buffer.push(0);
    unsafe {
        flatsql_parse(&mut result, text_buffer.as_ptr(), text_buffer.len());
        if result.status_code != 0 {
            let data = std::mem::transmute::<*mut cty::c_void, *const cty::c_char>(result.data_ptr);
            let c_msg = std::ffi::CStr::from_ptr(data);
            let msg = c_msg.to_str().unwrap_or_default().to_owned();
            return Err(msg);
        }
        let buffer = ProgramBuffer {
            data_length: result.data_length,
            data_ptr: std::mem::transmute::<*mut cty::c_void, *const u8>(result.data_ptr),
            owner_ptr: result.owner_ptr,
            owner_deleter: result.owner_deleter,
        };
        Ok(buffer)
    }
}

pub fn parse_into<'a, 'b>(
    alloc: &'a bumpalo::Bump,
    text: &'b str,
) -> Result<(proto::Program<'a>, &'a [u8]), Box<dyn Error + Send + Sync>> {
    let buffer = parse(text)?;
    let copy: &'a mut [u8] = alloc.alloc_slice_copy(buffer.access());
    Ok((flatbuffers::root::<proto::Program>(copy)?, copy))
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod test {
    use flatsql_proto as proto;
    use std::error::Error;

    #[test]
    fn test_parser_call() -> Result<(), Box<dyn Error + Send + Sync>> {
        let alloc = bumpalo::Bump::new();
        let (program, _program_buffer) = super::parse_into(&alloc, "select 1;")?;
        let stmts = program.statements().expect("must have statements");
        assert_eq!(stmts.len(), 1);
        assert_eq!(stmts.get(0).statement_type(), proto::StatementType::SELECT);
        Ok(())
    }
}
