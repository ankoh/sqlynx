if(POLICY CMP0063)
    cmake_policy(SET CMP0063 NEW)
endif()

add_library(utf8proc STATIC
    ${CMAKE_CURRENT_SOURCE_DIR}/utf8proc.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/utf8proc_wrapper.cpp
)
target_include_directories(utf8proc PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
