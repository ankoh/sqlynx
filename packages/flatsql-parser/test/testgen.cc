#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "flatbuffers/flatbuffers.h"
#include "flatsql/parser/parser_driver.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/test/grammar_tester.h"
#include "gtest/gtest.h"
#include "gtest/internal/gtest-internal.h"

using namespace flatsql;

namespace {

void generate_grammar_tests(const std::filesystem::path& source_dir) {
    auto grammar_dir = source_dir / "dumps";
    for (auto& p : std::filesystem::directory_iterator(grammar_dir)) {
        auto filename = p.path().filename().filename().string();

        // Is template file file
        auto out = p.path();
        if (out.extension() != ".xml") continue;
        out.replace_extension();
        if (out.extension() != ".tpl") continue;
        out.replace_extension(".xml");

        // Open input stream
        std::ifstream in(p.path(), std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[" << filename << "] failed to read file" << std::endl;
            continue;
        }

        // Open output stream
        std::cout << "FILE " << out << std::endl;
        std::ofstream outs;
        outs.open(out, std::ofstream::out | std::ofstream::trunc);

        // Parse xml document
        pugi::xml_document doc;
        doc.load(in);
        auto root = doc.child("astdumps");

        for (auto test : root.children()) {
            // Copy expected
            auto name = test.attribute("name").as_string();
            std::cout << "  TEST " << name << std::endl;

            /// Parse module
            auto input = test.child("input");
            auto input_buffer = std::string{input.last_child().value()};
            input_buffer.push_back(0);
            input_buffer.push_back(0);
            auto program = parser::ParserDriver::Parse(std::span<char>{input_buffer.data(), input_buffer.size()});

            /// Write output
            auto expected = test.append_child("expected");
            test::GrammarTest::EncodeProgram(expected, *program, input_buffer);
        }

        // Write xml document
        doc.save(outs, "    ", pugi::format_default | pugi::format_no_declaration);
    }
}

}  // namespace

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cout << "Usage: ./testgen <source_dir>" << std::endl;
        exit(1);
    }
    if (!argv[1] || !std::filesystem::exists(argv[1])) {
        std::cout << "Invalid directory: " << argv[1] << std::endl;
        exit(1);
    }
    std::filesystem::path source_dir{argv[1]};
    generate_grammar_tests(source_dir);
    return 0;
}
