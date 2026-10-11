# DashQL workspace - Bazel build for dashql-core (and optionally rest of repo).
# Grammar and packages are in the repo; external deps loaded here.

workspace(name = "dashql")

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

# Rules C++ (required for cc_* rules; use with --noenable_bzlmod)
http_archive(
    name = "rules_cc",
    sha256 = "44a8f325fa2b5cfb0ecaddda4365b3374eeefa1f97309fdb9301abb0897dfa7a",
    strip_prefix = "rules_cc-0.2.26",
    urls = ["https://github.com/bazelbuild/rules_cc/releases/download/0.2.26/rules_cc-0.2.26.tar.gz"],
)

# FlatBuffers (C++ runtime; same commit as CMake: ee848a0)
http_archive(
    name = "com_google_flatbuffers",
    strip_prefix = "flatbuffers-ee848a0",
    urls = ["https://github.com/google/flatbuffers/archive/ee848a0.zip"],
    build_file = "//bazel:external_flatbuffers.BUILD",
)

# Unordered dense (ankerl) - header only; same ref as CMake: 3add2a6
http_archive(
    name = "ankerl_unordered_dense",
    strip_prefix = "unordered_dense-3add2a6",
    urls = ["https://github.com/martinus/unordered_dense/archive/3add2a6.zip"],
    build_file = "//bazel:external_ankerl.BUILD",
)

# RapidJSON - header only
http_archive(
    name = "rapidjson",
    strip_prefix = "rapidjson-24b5e7a8b27f42fa16b96fc70aade9106cf7102f",
    urls = ["https://github.com/Tencent/rapidjson/archive/24b5e7a8b27f42fa16b96fc70aade9106cf7102f.zip"],
    build_file = "//bazel:external_rapidjson.BUILD",
)
