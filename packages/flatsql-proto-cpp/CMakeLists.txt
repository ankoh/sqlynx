set(PROTO_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/include")
set(PROTO_FILE "${PROTO_INCLUDE_DIR}/flatsql/proto/proto_generated.h")

if (NOT EXISTS "${PROTO_FILE}")
    message (FATAL_ERROR "Proto header does not exist. Did you forget to compile the flatbuffer schema?")
endif ()

add_library(flatsql_proto INTERFACE)
target_include_directories(flatsql_proto INTERFACE ${PROTO_INCLUDE_DIR})
target_link_libraries(flatsql_proto INTERFACE flatbuffers)