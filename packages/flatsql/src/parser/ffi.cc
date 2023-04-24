#include <span>

#include "flatbuffers/flatbuffers.h"
#include "flatsql/parser/parser_driver.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"

using namespace flatsql::parser;
namespace proto = flatsql::proto;

struct FFIResult {
    uint32_t status_code;
    uint32_t data_length;
    void* data_ptr;
    void* owner_ptr;
    void (*owner_deleter)(void*);
};

extern "C" FFIResult* flatsql_new_result() {
    auto result = new FFIResult();
    result->status_code = 0;
    result->data_length = 0;
    result->data_ptr = nullptr;
    result->owner_ptr = nullptr;
    result->owner_deleter = [](void* buffer) {};
    return result;
}

extern "C" char* flatsql_new_string(size_t length) {
    auto buffer = new char[length];
    memset(buffer, 0, (length + 2) * sizeof(char));  // Append 2 chars for flex
    return buffer;
}

extern "C" void flatsql_delete_result(FFIResult* result) {
    result->owner_deleter(result->owner_ptr);
    result->owner_ptr = nullptr;
    result->owner_deleter = nullptr;
    delete result;
}
extern "C" void flatsql_delete_string(char* buffer) { delete buffer; }

extern "C" void flatsql_parse(FFIResult* result, uint8_t* text, size_t length) {
    // Parse the program
    auto data = flatsql::rope::Rope::FromString(1024, std::string_view{reinterpret_cast<char*>(text), length});
    auto program = ParserDriver::Parse(data);

    // Pack the flatbuffer program
    flatbuffers::FlatBufferBuilder fb;
    auto program_ofs = proto::Program::Pack(fb, program.get());
    fb.Finish(program_ofs);

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    result->status_code = 0;
    result->data_ptr = detached->data();
    result->data_length = detached->size();
    result->owner_ptr = detached.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<flatbuffers::DetachedBuffer*>(buffer); };
}

#ifdef WASM
extern "C" int main() { return 0; }
#endif
