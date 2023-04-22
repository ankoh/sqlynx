include(ExternalProject)

ExternalProject_Add(
    benchmark_ep
    GIT_REPOSITORY "https://github.com/google/benchmark.git"
    GIT_TAG d572f47
    TIMEOUT 10
    PREFIX "external_benchmark"
    INSTALL_DIR "external_benchmark/install"
    UPDATE_DISCONNECTED True
    CMAKE_ARGS
        -DCMAKE_INSTALL_PREFIX=${CMAKE_BINARY_DIR}/external_benchmark/install
        -DCMAKE_CXX_STANDARD=20
        -DCMAKE_CXX_FLAGS=-std=c++20
        -DCMAKE_CXX_COMPILER=${CMAKE_CXX_COMPILER}
        -DCMAKE_CXX_COMPILER_LAUNCHER=${CMAKE_CXX_COMPILER_LAUNCHER}
        -DCMAKE_C_COMPILER=${CMAKE_C_COMPILER}
        -DCMAKE_C_COMPILER_LAUNCHER=${CMAKE_C_COMPILER_LAUNCHER}
        -DCMAKE_CXX_FLAGS=${CMAKE_CXX_FLAGS}
        -DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}
        -DCMAKE_BUILD_TYPE=Release
        -DBENCHMARK_ENABLE_TESTING=OFF
    BUILD_BYPRODUCTS <INSTALL_DIR>/lib/libbenchmark.a
)

ExternalProject_Get_Property(benchmark_ep install_dir)
set(BENCHMARK_INCLUDE_DIR ${install_dir}/include)
set(BENCHMARK_LIBRARY_PATH ${install_dir}/lib/libbenchmark.a)
add_library(benchmark STATIC IMPORTED)
set_property(TARGET benchmark PROPERTY IMPORTED_LOCATION ${BENCHMARK_LIBRARY_PATH})
set_property(TARGET benchmark APPEND PROPERTY INTERFACE_INCLUDE_DIRECTORIES ${BENCHMARK_INCLUDE_DIR})

add_dependencies(benchmark benchmark_ep)

file(MAKE_DIRECTORY ${BENCHMARK_INCLUDE_DIR})
