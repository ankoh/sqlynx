include(ExternalProject)

ExternalProject_Add(
    flatbuffers_ep
    GIT_REPOSITORY "https://github.com/google/flatbuffers.git"
    GIT_TAG ee848a0
    TIMEOUT 10
    PREFIX "external_flatbuffers"
    INSTALL_DIR "external_flatbuffers/install"
    CMAKE_ARGS
        -G${CMAKE_GENERATOR}
        -DWASI_SDK_PREFIX=${WASI_SDK_PREFIX}
        -DCMAKE_INSTALL_PREFIX=${CMAKE_BINARY_DIR}/external_flatbuffers/install
        -DCMAKE_CXX_STANDARD=20
        -DCMAKE_CXX_FLAGS=-DFLATBUFFERS_NO_ABSOLUTE_PATH_RESOLUTION
        -DCMAKE_CXX_COMPILER=${CMAKE_CXX_COMPILER}
        -DCMAKE_CXX_COMPILER_LAUNCHER=${CMAKE_CXX_COMPILER_LAUNCHER}
        -DCMAKE_C_COMPILER_LAUNCHER=${CMAKE_C_COMPILER_LAUNCHER}
        -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
        -DCMAKE_SYSROOT=${CMAKE_SYSROOT}
        -DCMAKE_MODULE_PATH=${CMAKE_MODULE_PATH}
        -DCMAKE_BUILD_TYPE=Release
        -DFLATBUFFERS_BUILD_TESTS=OFF
        -DFLATBUFFERS_BUILD_FLATLIB=ON
        -DFLATBUFFERS_BUILD_FLATC=OFF
        -DFLATBUFFERS_BUILD_FLATHASH=OFF
        -DFLATBUFFERS_BUILD_SHAREDLIB=OFF
        -DFLATBUFFERS_INSTALL=ON
    BUILD_BYPRODUCTS <INSTALL_DIR>/lib/libflatbuffers.a
)

ExternalProject_Get_Property(flatbuffers_ep install_dir)
set(FLATBUFFERS_INCLUDE_DIR ${install_dir}/include)
set(FLATBUFFERS_LIBRARY_PATH ${install_dir}/lib/libflatbuffers.a)
add_library(flatbuffers STATIC IMPORTED)
set_property(TARGET flatbuffers PROPERTY IMPORTED_LOCATION ${FLATBUFFERS_LIBRARY_PATH})
set_property(TARGET flatbuffers APPEND PROPERTY INTERFACE_INCLUDE_DIRECTORIES ${FLATBUFFERS_INCLUDE_DIR})
add_dependencies(flatbuffers flatbuffers_ep)

file(MAKE_DIRECTORY ${FLATBUFFERS_INCLUDE_DIR})
