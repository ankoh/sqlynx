#include <array>
#include <deque>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "c4/yml/emit.hpp"
#include "c4/yml/std/std.hpp"
#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "dashql/exception.h"
#include "dashql/formatter/formatter.h"
#include "dashql/parser/parser.h"
#include "dashql/parser/scanner.h"
#include "dashql/script.h"
#include "dashql/script_diff.h"
#include "dashql/testing/analyzer_snapshot_test.h"
#include "dashql/testing/completion_snapshot_test.h"
#include "dashql/testing/diff_snapshot_test.h"
#include "dashql/testing/parser_snapshot_test.h"
#include "dashql/testing/plan_view_model_snapshot_test.h"
#include "dashql/testing/planner_snapshot_test.h"
#include "dashql/testing/visualize_snapshot_test.h"
#include "dashql/testing/yaml_tests.h"
#include "dashql/visualize/markdown.h"
#include "dashql/visualize/umap.h"
#include "dashql/visualize/vegalite.h"
#include "dashql/utils/string_trimming.h"
#include "dashql/view/plan_view_model.h"
#include "gflags/gflags.h"

using namespace dashql;
using namespace dashql::testing;

DEFINE_string(source_dir, "", "Source directory");
DEFINE_string(
    filter, "",
    "Snapshot category to update (parser, analyzer, planner, completion, formatter, plan_view_model, visualize, diff). "
    "Empty = all.");

static void generate_parser_snapshots(const std::filesystem::path& snapshot_dir) {
    for (auto& p : std::filesystem::directory_iterator(snapshot_dir)) {
        auto path = p.path();
        if (path.extension() != ".yaml") continue;
        auto stem = path.stem().string();

        // Is a template?
        const bool is_tpl = (path.stem().extension() == ".tpl");
        if (!is_tpl) continue;

        // stem is e.g. "simple.tpl", output is simple.yaml
        auto out = path;
        out.replace_extension();
        out.replace_extension(".yaml");  // simple.tpl.yaml -> simple.yaml

        std::ifstream in(path, std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[" << path.filename().string() << "] failed to read file" << std::endl;
            continue;
        }
        std::stringstream buf;
        buf << in.rdbuf();
        std::string content = buf.str();

        // Parse the yaml
        c4::yml::Tree tpl_tree;
        c4::yml::parse_in_arena(c4::to_csubstr(content), &tpl_tree);
        auto root = tpl_tree.rootref();
        if (!root.has_child("parser-snapshots")) {
            std::cout << "[" << path.filename().string() << "] no parser-snapshots key" << std::endl;
            continue;
        }

        std::cout << "FILE " << out << std::endl;
        c4::yml::Tree out_tree;
        auto out_root = out_tree.rootref();
        out_root.set_type(c4::yml::MAP);
        auto snapshots_node = out_root.append_child();
        snapshots_node << c4::yml::key("parser-snapshots");
        snapshots_node |= c4::yml::SEQ;

        auto tpl_snapshots = root["parser-snapshots"];
        for (auto test_node : tpl_snapshots.children()) {
            std::string name;
            if (test_node.has_child("name")) {
                c4::csubstr v = test_node["name"].val();
                if (v.str) name.assign(v.str, v.len);
            }
            std::string input_buffer;
            if (test_node.has_child("input")) {
                c4::csubstr v = test_node["input"].val();
                if (v.str) {
                    std::string_view trimmed = trim_view_right(trim_view_left(std::string_view{v.str, v.len}, is_no_space), is_no_newline);
                    input_buffer.assign(trimmed.data(), trimmed.size());
                }
            }
            bool debug = false;
            if (test_node.has_child("debug")) {
                c4::csubstr v = test_node["debug"].val();
                debug = (v == "true" || v == "1");
            }
            std::cout << "  TEST " << name << std::endl;

            rope::Rope input_rope{1024, input_buffer};
            try {
                auto scanned = parser::Scanner::Scan(input_rope, 0, 1);
                auto parsed = parser::Parser::Parse(scanned);

                auto item = snapshots_node.append_child();
                item.set_type(c4::yml::MAP);
                item.append_child() << c4::yml::key("name") << name;

                auto input_node = item.append_child();
                input_node << c4::yml::key("input") << input_buffer;
                input_node.set_val_style(c4::yml::VAL_LITERAL);

                if (debug) item.append_child() << c4::yml::key("debug") << "true";
                auto expected_node = item.append_child();
                expected_node << c4::yml::key("expected");
                expected_node |= c4::yml::MAP;

                ParserSnapshotTest::EncodeScript(expected_node, *scanned, *parsed, input_buffer);
            } catch (const dashql::Exception& e) {
                std::cout << "  ERROR " << buffers::status::EnumNameStatusCode(e.GetCode()) << std::endl;
                continue;
            }
        }

        // Emit from the first child (parser-snapshots) so output is a single doc with one top-level key.
        // rapidyaml's emitter is recursive: each container does ++depth, recurse, --depth. So deep ASTs
        // (e.g. tpcds) need max_depth well above the default (64) or emit fails
        c4::yml::NodeRef to_emit = out_tree.ref(out_tree.first_child(out_tree.root_id()));
        std::string emitted = c4::yml::emitrs_yaml<std::string>(to_emit, c4::yml::EmitOptions().max_depth(128));
        InjectBlankLinesInSnapshot(emitted);
        std::ofstream outs(out, std::ofstream::out | std::ofstream::trunc);
        outs << emitted;
    }
}

static std::unique_ptr<Script> read_script_yml(c4::yml::ConstNodeRef node, Catalog& catalog) {
    std::string input;
    if (node.is_map() && node.has_child("input")) {
        c4::csubstr v = node["input"].val();
        if (v.str) {
            std::string_view trimmed = trim_view_right(trim_view_left(std::string_view{v.str, v.len}, is_no_space), is_no_newline);
            input.assign(trimmed.data(), trimmed.size());
        }
    } else if (node.has_val()) {
        c4::csubstr v = node.val();
        if (v.str) {
            std::string_view trimmed = trim_view_right(trim_view_left(std::string_view{v.str, v.len}, is_no_space), is_no_newline);
            input.assign(trimmed.data(), trimmed.size());
        }
    }
    auto script = std::make_unique<Script>(catalog);
    script->InsertTextAt(0, input);
    try {
        script->Scan();
        script->Parse();
        script->Analyze();
    } catch (const dashql::Exception& e) {
        std::cout << "  ERROR " << buffers::status::EnumNameStatusCode(e.GetCode()) << std::endl;
        return nullptr;
    }
    return script;
}

static std::unique_ptr<Catalog> read_catalog_yml(c4::yml::Tree& tree, c4::yml::NodeRef catalog_node,
                                                 std::vector<std::unique_ptr<Script>>& catalog_scripts) {
    auto catalog = std::make_unique<Catalog>();
    if (catalog_node.has_child("script")) {
        auto script_node = catalog_node["script"];
        auto script_ref = tree.ref(script_node.id());
        auto script = read_script_yml(script_node, *catalog);
        if (script) {
            size_t rank = script->GetCatalogEntryId();
            catalog->LoadScript(*script, rank);
            AnalyzerSnapshotTest::EncodeScript(script_ref, *script->analyzed_script, false);
            catalog_scripts.push_back(std::move(script));
        }
    }
    return catalog;
}

static void generate_analyzer_snapshots(const std::filesystem::path& snapshot_dir) {
    for (auto& p : std::filesystem::directory_iterator(snapshot_dir)) {
        auto path = p.path();
        if (path.extension() != ".yaml") continue;
        auto stem = path.stem().string();
        const bool is_tpl = (path.stem().extension() == ".tpl");
        if (!is_tpl) continue;

        auto out = path;
        out.replace_extension();
        out.replace_extension(".yaml");  // basic.tpl.yaml -> basic.yaml

        std::ifstream in(path, std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[" << path.filename().string() << "] failed to read file" << std::endl;
            continue;
        }
        std::stringstream buf;
        buf << in.rdbuf();
        std::string content = buf.str();

        c4::yml::Tree tree;
        c4::yml::parse_in_arena(c4::to_csubstr(content), &tree);
        auto root = tree.rootref();
        if (!root.has_child("analyzer-snapshots")) {
            std::cout << "[" << path.filename().string() << "] no analyzer-snapshots key" << std::endl;
            continue;
        }

        std::cout << "FILE " << out << std::endl;
        auto snapshots = root["analyzer-snapshots"];
        for (auto test_node : snapshots.children()) {
            if (!test_node.has_child("name")) continue;
            c4::csubstr name_v = test_node["name"].val();
            std::string name = name_v.str ? std::string(name_v.str, name_v.len) : std::string();
            std::cout << "  TEST " << name << std::endl;

            std::unique_ptr<Catalog> catalog;
            std::vector<std::unique_ptr<Script>> catalog_scripts;
            if (test_node.has_child("catalog")) {
                auto catalog_node = tree.ref(test_node["catalog"].id());
                catalog = read_catalog_yml(tree, catalog_node, catalog_scripts);
            } else {
                catalog = std::make_unique<Catalog>();
            }
            if (!test_node.has_child("script")) continue;
            auto script_node = test_node["script"];
            auto script_ref = tree.ref(script_node.id());
            auto main_script = read_script_yml(script_node, *catalog);
            if (main_script) {
                AnalyzerSnapshotTest::EncodeScript(script_ref, *main_script->analyzed_script, true);
            }
        }

        c4::yml::NodeRef to_emit = tree.ref(tree.first_child(tree.root_id()));
        std::string emitted = c4::yml::emitrs_yaml<std::string>(to_emit, c4::yml::EmitOptions().max_depth(128));
        InjectBlankLinesInSnapshot(emitted);
        std::ofstream outs(out, std::ofstream::out | std::ofstream::trunc);
        outs << emitted;
    }
}

static void generate_planner_snapshots(const std::filesystem::path& snapshot_dir) {
    for (auto& entry : std::filesystem::directory_iterator(snapshot_dir)) {
        auto path = entry.path();
        if (path.extension() != ".yaml" || path.stem().extension() != ".tpl") continue;
        std::ifstream input(path);
        if (!input) throw std::runtime_error("cannot read planner template: " + path.string());
        std::stringstream buffer;
        buffer << input.rdbuf();
        auto content = buffer.str();
        c4::yml::Tree tree;
        c4::yml::parse_in_arena(c4::to_csubstr(content), &tree);
        auto out = path;
        out.replace_extension();
        out.replace_extension(".yaml");
        std::cout << "FILE " << out << std::endl;
        for (auto fixture : tree.rootref()["planner-snapshots"].children()) {
            std::cout << "  TEST " << fixture["name"].val() << std::endl;
            if (fixture.has_child("expected")) fixture.remove_child("expected");
            auto expected = fixture.append_child();
            expected << c4::yml::key("expected");
            PlannerSnapshotTest::Encode(expected, fixture);
        }
        auto emitted = c4::yml::emitrs_yaml<std::string>(tree.rootref(), c4::yml::EmitOptions().max_depth(128));
        InjectBlankLinesInSnapshot(emitted);
        std::ofstream output(out, std::ios::trunc);
        if (!output) throw std::runtime_error("cannot write planner snapshot: " + out.string());
        output << emitted;
    }
}

static void generate_completion_snapshots(const std::filesystem::path& snapshot_dir) {
    for (auto& p : std::filesystem::directory_iterator(snapshot_dir)) {
        auto path = p.path();
        if (path.extension() != ".yaml") continue;
        if (path.stem().extension() != ".tpl") continue;

        auto out = path;
        out.replace_extension();
        out.replace_extension(".yaml");

        std::ifstream in(path, std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[" << path.filename().string() << "] failed to read file" << std::endl;
            continue;
        }
        std::stringstream buf;
        buf << in.rdbuf();
        std::string content = buf.str();

        c4::yml::Tree tree;
        c4::yml::parse_in_arena(c4::to_csubstr(content), &tree);
        auto root = tree.rootref();
        if (!root.has_child("completion-snapshots")) continue;

        std::cout << "FILE " << out << std::endl;
        auto snapshots = root["completion-snapshots"];
        for (auto test_node : snapshots.children()) {
            if (!test_node.has_child("name")) continue;
            c4::csubstr name_v = test_node["name"].val();
            std::string name = name_v.str ? std::string(name_v.str, name_v.len) : std::string();
            std::cout << "  TEST " << name << std::endl;

            std::unique_ptr<Catalog> catalog;
            std::vector<std::unique_ptr<Script>> catalog_scripts;
            if (test_node.has_child("catalog")) {
                auto catalog_node = tree.ref(test_node["catalog"].id());
                catalog = read_catalog_yml(tree, catalog_node, catalog_scripts);
            } else {
                catalog = std::make_unique<Catalog>();
            }

            if (!test_node.has_child("editor")) continue;
            auto editor_node = test_node["editor"];
            auto editor_script = read_script_yml(editor_node, *catalog);
            if (!editor_script) continue;
            auto editor_ref = tree.ref(editor_node.id());
            editor_ref.clear_val();
            editor_ref |= c4::yml::MAP;  // add MAP (keep KEY); EncodeScript needs a container
            AnalyzerSnapshotTest::EncodeScript(editor_ref, *editor_script->analyzed_script, true);

            std::string cursor_search_text;
            size_t cursor_search_index = 0;
            if (test_node.has_child("cursor") && test_node["cursor"].has_child("search")) {
                auto search = test_node["cursor"]["search"];
                if (search.has_child("text")) {
                    c4::csubstr v = search["text"].val();
                    cursor_search_text = v.str ? std::string(v.str, v.len) : std::string();
                }
                if (search.has_child("index")) {
                    c4::csubstr v = search["index"].val();
                    cursor_search_index = v.str ? static_cast<size_t>(std::atoi(v.str)) : 0;
                }
            }

            std::string_view target_text = editor_script->scanned_script->GetInput();
            auto search_pos = target_text.find(cursor_search_text);
            if (search_pos == std::string_view::npos) {
                std::cout << "  ERROR couldn't locate cursor `" << cursor_search_text << "`" << std::endl;
                continue;
            }
            auto cursor_pos = search_pos + cursor_search_index;
            if (cursor_pos > target_text.size()) {
                std::cout << "  ERROR cursor index out of bounds" << std::endl;
                continue;
            }

            if (!test_node.has_child("completions")) continue;
            size_t limit = 100;
            if (test_node["completions"].has_child("limit")) {
                c4::csubstr v = test_node["completions"]["limit"].val();
                limit = v.str ? static_cast<size_t>(std::atoi(v.str)) : 100;
            }
            auto completions_node = tree.ref(test_node["completions"].id());

            editor_script->MoveCursor(cursor_pos);
            try {
                auto completion = editor_script->CompleteAtCursor(limit);
                CompletionSnapshotTest::EncodeCompletion(completions_node, *completion);
                EncodeLocationText(completions_node, completion->GetTargetSymbol()->symbol.location, target_text,
                                   "text");
            } catch (const dashql::Exception& e) {
                std::cout << "  ERROR " << buffers::status::EnumNameStatusCode(e.GetCode()) << std::endl;
                continue;
            }
        }

        c4::yml::NodeRef to_emit = tree.ref(tree.first_child(tree.root_id()));
        std::string emitted = c4::yml::emitrs_yaml<std::string>(to_emit, c4::yml::EmitOptions().max_depth(128));
        InjectBlankLinesInSnapshot(emitted);
        std::ofstream outs(out, std::ofstream::out | std::ofstream::trunc);
        outs << emitted;
    }
}

template <typename ParseFn>
static void generate_planviewmodel_snapshots(const std::filesystem::path& snapshot_dir, ParseFn parse_plan) {
    for (auto& p : std::filesystem::directory_iterator(snapshot_dir)) {
        auto path = p.path();
        if (path.extension() != ".yaml") continue;
        const bool is_tpl = (path.stem().extension() == ".tpl");
        if (!is_tpl) continue;

        auto out = path;
        out.replace_extension();
        out.replace_extension(".yaml");

        std::ifstream in(path, std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[" << path.filename().string() << "] failed to read file" << std::endl;
            continue;
        }
        std::stringstream buf;
        buf << in.rdbuf();
        std::string content = buf.str();

        c4::yml::Tree tpl_tree;
        c4::yml::parse_in_arena(c4::to_csubstr(content), &tpl_tree);
        auto tpl_root = tpl_tree.rootref();
        if (!tpl_root.has_child("plan-snapshots")) {
            std::cout << "[" << path.filename().string() << "] no plan-snapshots key" << std::endl;
            continue;
        }

        std::cout << "FILE " << out << std::endl;
        c4::yml::Tree out_tree;
        out_tree.reserve_arena(16 * 1024 * 1024);
        auto out_root = out_tree.rootref();
        out_root.set_type(c4::yml::MAP);
        auto out_snapshots = out_root.append_child();
        out_tree.to_seq(out_snapshots.id(), out_tree.to_arena(c4::to_csubstr("plan-snapshots")));

        // Keep name/input strings alive until after emit (tree stores csubstr pointers)
        std::deque<std::string> string_storage;
        auto tpl_snapshots = tpl_root["plan-snapshots"];
        for (auto test_node : tpl_snapshots.children()) {
            if (!test_node.has_child("name")) continue;
            c4::csubstr name_v = test_node["name"].val();
            std::string name = name_v.str ? std::string(name_v.str, name_v.len) : std::string();
            std::cout << "  TEST " << name << std::endl;

            if (!test_node.has_child("input")) continue;
            c4::csubstr input_v = test_node["input"].val();
            std::string input_buffer = input_v.str ? std::string(input_v.str, input_v.len) : std::string();
            std::string input_for_yaml = input_buffer;

            PlanViewModel view_model;
            try {
                parse_plan(view_model, std::move(input_buffer));
            } catch (const dashql::Exception& e) {
                std::cout << "  ERROR " << buffers::status::EnumNameStatusCode(e.GetCode()) << std::endl;
                continue;
            }

            buffers::view::PlanLayoutConfig config;
            config.mutate_level_height(64.0);
            config.mutate_node_height(32.0);
            config.mutate_node_margin_horizontal(20.0);
            config.mutate_node_padding_left(8.0);
            config.mutate_node_padding_right(8.0);
            config.mutate_icon_width(14.0);
            config.mutate_icon_margin_right(8.0);
            config.mutate_max_label_chars(20);
            config.mutate_width_per_label_char(8.5);
            config.mutate_node_min_width(0);
            view_model.Configure(config);
            view_model.ComputeLayout();

            string_storage.push_back(name);
            string_storage.push_back(input_for_yaml);
            const std::string& name_ref = string_storage[string_storage.size() - 2];
            const std::string& input_ref = string_storage[string_storage.size() - 1];

            // Use Tree::to_keyval so key+val and KEYVAL type are set in one call (emitter requires has_key on map
            // children)
            auto test_ref = out_snapshots.append_child();
            test_ref.set_type(c4::yml::MAP);
            c4::yml::Tree* tr = out_root.tree();
            auto n_name = test_ref.append_child();
            tr->to_keyval(n_name.id(), tr->to_arena(c4::to_csubstr("name")), tr->to_arena(c4::to_csubstr(name_ref)));
            auto n_input = test_ref.append_child();
            tr->to_keyval(n_input.id(), tr->to_arena(c4::to_csubstr("input")), tr->to_arena(c4::to_csubstr(input_ref)));
            n_input.set_val_style(c4::yml::VAL_LITERAL);
            PlanViewModelSnapshotTest::EncodePlanViewModel(test_ref, view_model);
        }

        c4::yml::id_type snap_id = out_tree.first_child(out_tree.root_id());
        c4::yml::NodeRef to_emit = out_tree.ref(snap_id);
        std::string emitted = c4::yml::emitrs_yaml<std::string>(to_emit, c4::yml::EmitOptions().max_depth(128));
        InjectBlankLinesInSnapshot(emitted);
        std::ofstream outs(out, std::ofstream::out | std::ofstream::trunc);
        outs << emitted;
    }
}

static void generate_hyper_plan_snapshots(const std::filesystem::path& snapshot_dir) {
    generate_planviewmodel_snapshots(snapshot_dir, [](PlanViewModel& view_model, std::string input_buffer) {
        view_model.ParseHyperPlan(std::move(input_buffer));
    });
}

static void generate_formatter_snapshots(const std::filesystem::path& snapshot_dir) {
    static constexpr std::array<buffers::formatting::FormattingMode, 3> ALL_MODES = {
        buffers::formatting::FormattingMode::INLINE, buffers::formatting::FormattingMode::COMPACT,
        buffers::formatting::FormattingMode::PRETTY};

    for (auto& p : std::filesystem::directory_iterator(snapshot_dir)) {
        auto path = p.path();
        if (path.extension() != ".yaml") continue;
        if (path.stem().extension() != ".tpl") continue;

        auto out = path;
        out.replace_extension();
        out.replace_extension(".yaml");

        std::ifstream in(path, std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[" << path.filename().string() << "] failed to read file" << std::endl;
            continue;
        }
        std::stringstream buf;
        buf << in.rdbuf();
        std::string content = buf.str();

        c4::yml::Tree tpl_tree;
        c4::yml::parse_in_arena(c4::to_csubstr(content), &tpl_tree);
        auto tpl_root = tpl_tree.rootref();
        if (!tpl_root.has_child("formatter-snapshots")) {
            std::cout << "[" << path.filename().string() << "] no formatter-snapshots key" << std::endl;
            continue;
        }

        std::cout << "FILE " << out << std::endl;

        c4::yml::Tree out_tree;
        out_tree.reserve_arena(content.size() + 64 * 1024);
        auto out_root = out_tree.rootref();
        out_root.set_type(c4::yml::MAP);
        auto out_snapshots = out_root.append_child();
        out_snapshots << c4::yml::key("formatter-snapshots");
        out_snapshots |= c4::yml::SEQ;

        auto tpl_snapshots = tpl_root["formatter-snapshots"];
        for (auto test_node : tpl_snapshots.children()) {
            if (!test_node.has_child("name") || !test_node.has_child("input")) continue;
            c4::csubstr name_v = test_node["name"].val();
            std::string name = name_v.str ? std::string(name_v.str, name_v.len) : std::string();
            std::cout << "  TEST " << name << std::endl;

            c4::csubstr input_v = test_node["input"].val();
            std::string input_buffer =
                input_v.str ? std::string(trim_view_right(
                    trim_view_left(std::string_view{input_v.str, input_v.len}, is_no_space), is_no_newline))
                            : std::string();
            try {
                rope::Rope input_rope{1024, input_buffer};
                auto scanned = parser::Scanner::Scan(input_rope, 0, 1);
                auto parsed = parser::Parser::Parse(scanned);
                Formatter formatter{*parsed};

                auto out_test = out_snapshots.append_child();
                out_test.set_type(c4::yml::MAP);
                out_test.append_child() << c4::yml::key("name") << name;
                auto input_node = out_test.append_child();
                input_node << c4::yml::key("input") << input_buffer;
                input_node.set_val_style(c4::yml::VAL_LITERAL);

                if (!test_node.has_child("dialects")) continue;
                auto out_dialects = out_test.append_child();
                out_dialects << c4::yml::key("dialects");
                out_dialects |= c4::yml::MAP;

                for (auto dialect_node : test_node["dialects"].children()) {
                    c4::csubstr dialect_key = dialect_node.key();
                    std::string dialect_str =
                        dialect_key.str ? std::string(dialect_key.str, dialect_key.len) : std::string();
                    buffers::formatting::FormattingDialect dialect = ParseFormattingDialect(dialect_str);

                    // Check for skip flag — propagate to output without generating expectations
                    bool dialect_skip = false;
                    if (dialect_node.is_map() && dialect_node.has_child("skip")) {
                        c4::csubstr sv = dialect_node["skip"].val();
                        dialect_skip = (sv == "true" || sv == "1");
                    }
                    if (dialect_skip) {
                        auto out_dialect = out_dialects.append_child();
                        out_dialect.set_key(out_tree.to_arena(c4::to_csubstr(dialect_str)));
                        out_dialect |= c4::yml::MAP;
                        out_dialect.append_child() << c4::yml::key("skip") << "true";
                        continue;
                    }

                    // Read per-mode setting overrides from the template's formatted list.
                    // Only modes that carry non-default settings need to be listed in the template.
                    struct ModeOverride {
                        size_t indent = FORMATTING_DEFAULT_INDENTATION_WIDTH;
                        size_t width = FORMATTING_DEFAULT_MAX_WIDTH;
                    };
                    ModeOverride mode_overrides[3];  // [0]=Inline, [1]=Compact, [2]=Pretty
                    bool has_override[3] = {false, false, false};
                    auto mode_index = [](buffers::formatting::FormattingMode m) -> size_t {
                        switch (m) {
                            case buffers::formatting::FormattingMode::INLINE:
                                return 0;
                            case buffers::formatting::FormattingMode::COMPACT:
                                return 1;
                            case buffers::formatting::FormattingMode::PRETTY:
                                return 2;
                        }
                        return 1;
                    };
                    if (dialect_node.is_map() && dialect_node.has_child("formatted")) {
                        for (auto fn : dialect_node["formatted"].children()) {
                            buffers::formatting::FormattingMode mode = ParseFormattingMode(
                                fn.has_child("mode") ? std::string(fn["mode"].val().str, fn["mode"].val().len)
                                                     : std::string("compact"));
                            size_t idx = mode_index(mode);
                            has_override[idx] = true;
                            mode_overrides[idx].indent = fn.has_child("indent")
                                                             ? static_cast<size_t>(std::atoi(fn["indent"].val().str))
                                                             : FORMATTING_DEFAULT_INDENTATION_WIDTH;
                            mode_overrides[idx].width = fn.has_child("width")
                                                            ? static_cast<size_t>(std::atoi(fn["width"].val().str))
                                                            : FORMATTING_DEFAULT_MAX_WIDTH;
                        }
                    }

                    auto out_dialect = out_dialects.append_child();
                    out_dialect.set_key(out_tree.to_arena(c4::to_csubstr(dialect_str)));
                    out_dialect |= c4::yml::MAP;

                    auto out_formatted = out_dialect.append_child();
                    out_formatted << c4::yml::key("formatted");
                    out_formatted |= c4::yml::SEQ;

                    for (auto mode : ALL_MODES) {
                        buffers::formatting::FormattingConfigT cfg;
                        cfg.dialect = dialect;
                        cfg.mode = mode;
                        cfg.indentation_width = FORMATTING_DEFAULT_INDENTATION_WIDTH;
                        cfg.max_width = FORMATTING_DEFAULT_MAX_WIDTH;
                        size_t idx = mode_index(mode);
                        if (has_override[idx]) {
                            cfg.indentation_width = mode_overrides[idx].indent;
                            cfg.max_width = mode_overrides[idx].width;
                        }
                        std::string formatted = formatter.Format(cfg);

                        auto out_entry = out_formatted.append_child();
                        out_entry.set_type(c4::yml::MAP);
                        std::string mode_str{FormattingModeToString(cfg.mode)};
                        out_entry.append_child() << c4::yml::key("mode") << out_tree.to_arena(c4::to_csubstr(mode_str));
                        if (cfg.indentation_width != FORMATTING_DEFAULT_INDENTATION_WIDTH) {
                            std::string indent_str = std::to_string(cfg.indentation_width);
                            out_entry.append_child()
                                << c4::yml::key("indent") << out_tree.to_arena(c4::to_csubstr(indent_str));
                        }
                        if (cfg.max_width != FORMATTING_DEFAULT_MAX_WIDTH) {
                            std::string width_str = std::to_string(cfg.max_width);
                            out_entry.append_child()
                                << c4::yml::key("width") << out_tree.to_arena(c4::to_csubstr(width_str));
                        }
                        auto expected_node = out_entry.append_child();
                        expected_node << c4::yml::key("expected");
                        expected_node.set_val(out_tree.to_arena(c4::to_csubstr(formatted)));
                        expected_node.set_val_style(c4::yml::VAL_LITERAL);
                    }

                    if (dialect_node.is_map() && dialect_node.has_child("validation")) {
                        auto out_val = out_dialect.append_child();
                        out_val << c4::yml::key("validation");
                        c4::csubstr setup_v;
                        auto val_tpl = dialect_node["validation"];
                        if (val_tpl.is_map() && val_tpl.has_child("setup")) {
                            setup_v = val_tpl["setup"].val();
                        }
                        if (setup_v.str) {
                            out_val |= c4::yml::MAP;
                            std::string setup_str{setup_v.str, setup_v.len};
                            auto setup_node = out_val.append_child();
                            setup_node << c4::yml::key("setup");
                            setup_node.set_val(out_tree.to_arena(c4::to_csubstr(setup_str)));
                            setup_node.set_val_style(c4::yml::VAL_LITERAL);
                        } else {
                            out_val.set_val(c4::csubstr{});
                        }
                    }
                }
            } catch (const dashql::Exception& e) {
                std::cout << "  ERROR " << buffers::status::EnumNameStatusCode(e.GetCode()) << std::endl;
                continue;
            }
        }

        c4::yml::NodeRef to_emit = out_tree.ref(out_tree.first_child(out_tree.root_id()));
        std::string emitted = c4::yml::emitrs_yaml<std::string>(to_emit, c4::yml::EmitOptions().max_depth(128));
        InjectBlankLinesInSnapshot(emitted);
        std::ofstream outs(out, std::ofstream::out | std::ofstream::trunc);
        outs << emitted;
    }
}

static void generate_visualize_snapshots(const std::filesystem::path& snapshot_dir) {
    for (auto& p : std::filesystem::directory_iterator(snapshot_dir)) {
        auto path = p.path();
        if (path.extension() != ".yaml") continue;
        if (path.stem().extension() != ".tpl") continue;

        auto out = path;
        out.replace_extension();
        out.replace_extension(".yaml");

        std::ifstream in(path, std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[" << path.filename().string() << "] failed to read file" << std::endl;
            continue;
        }
        std::stringstream buf;
        buf << in.rdbuf();
        std::string content = buf.str();

        c4::yml::Tree tree;
        c4::yml::parse_in_arena(c4::to_csubstr(content), &tree);
        auto root = tree.rootref();
        if (!root.has_child("visualize-snapshots")) {
            std::cout << "[" << path.filename().string() << "] no visualize-snapshots key" << std::endl;
            continue;
        }

        std::cout << "FILE " << out << std::endl;
        auto snapshots = root["visualize-snapshots"];
        for (auto test_node : snapshots.children()) {
            if (!test_node.has_child("name")) continue;
            c4::csubstr name_v = test_node["name"].val();
            std::string name = name_v.str ? std::string(name_v.str, name_v.len) : std::string();
            std::cout << "  TEST " << name << std::endl;

            std::unique_ptr<Catalog> catalog;
            std::vector<std::unique_ptr<Script>> catalog_scripts;
            if (test_node.has_child("catalog")) {
                auto catalog_node = tree.ref(test_node["catalog"].id());
                catalog = read_catalog_yml(tree, catalog_node, catalog_scripts);
            } else {
                catalog = std::make_unique<Catalog>();
            }
            if (!test_node.has_child("script")) continue;
            auto script_node = test_node["script"];
            auto main_script = read_script_yml(script_node, *catalog);
            if (!main_script) continue;

            auto& analyzed = *main_script->analyzed_script;
            if (analyzed.visualization_specs.IsEmpty()) continue;

            auto& spec = analyzed.visualization_specs[0];
            bool is_umap = spec.renderer.has_value() && *spec.renderer == "umap";
            bool is_markdown = spec.renderer.has_value() && *spec.renderer == "markdown";

            auto test_ref = tree.ref(test_node.id());
            // Stale keys from either renderer are cleared so switching a test's renderer
            // does not leave orphaned output behind.
            if (test_ref.has_child("vegalite")) test_ref.remove_child("vegalite");
            if (test_ref.has_child("roundtrip")) test_ref.remove_child("roundtrip");
            if (test_ref.has_child("umap")) test_ref.remove_child("umap");
            if (test_ref.has_child("markdown")) test_ref.remove_child("markdown");

            if (is_umap) {
                auto umap = visualize::CompileUmapSpec(spec, analyzed);
                if (!umap) continue;
                auto umap_node = test_ref.append_child();
                umap_node << c4::yml::key("umap");
                EncodeUmapSpec(umap_node, *umap);
            } else if (is_markdown) {
                auto markdown = visualize::CompileMarkdownSpec(spec);
                if (!markdown) continue;
                auto markdown_node = test_ref.append_child();
                markdown_node << c4::yml::key("markdown");
                EncodeMarkdownSpec(markdown_node, *markdown);
            } else {
                std::string vegalite_json = visualize::GenerateVegaLiteSpec(spec, analyzed);
                std::string roundtrip = visualize::ParseVegaLiteToVisualize(vegalite_json);

                auto vl_node = test_ref.append_child();
                vl_node << c4::yml::key("vegalite") << vegalite_json;
                vl_node.set_val_style(c4::yml::VAL_LITERAL);

                auto rt_node = test_ref.append_child();
                rt_node << c4::yml::key("roundtrip") << roundtrip;
                rt_node.set_val_style(c4::yml::VAL_LITERAL);
            }
        }

        c4::yml::NodeRef to_emit = tree.ref(tree.first_child(tree.root_id()));
        std::string emitted = c4::yml::emitrs_yaml<std::string>(to_emit, c4::yml::EmitOptions().max_depth(128));
        InjectBlankLinesInSnapshot(emitted);
        std::ofstream outs(out, std::ofstream::out | std::ofstream::trunc);
        outs << emitted;
    }
}

static void generate_diff_snapshots(const std::filesystem::path& snapshot_dir) {
    for (auto& p : std::filesystem::directory_iterator(snapshot_dir)) {
        auto path = p.path();
        if (path.extension() != ".yaml") continue;
        if (path.stem().extension() != ".tpl") continue;

        auto out = path;
        out.replace_extension();
        out.replace_extension(".yaml");  // basic.tpl.yaml -> basic.yaml

        std::ifstream in(path, std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[" << path.filename().string() << "] failed to read file" << std::endl;
            continue;
        }
        std::stringstream buf;
        buf << in.rdbuf();
        std::string content = buf.str();

        c4::yml::Tree tpl_tree;
        c4::yml::parse_in_arena(c4::to_csubstr(content), &tpl_tree);
        auto tpl_root = tpl_tree.rootref();
        if (!tpl_root.has_child("diff-snapshots")) {
            std::cout << "[" << path.filename().string() << "] no diff-snapshots key" << std::endl;
            continue;
        }

        std::cout << "FILE " << out << std::endl;
        c4::yml::Tree out_tree;
        auto out_root = out_tree.rootref();
        out_root.set_type(c4::yml::MAP);
        auto snapshots_node = out_root.append_child();
        snapshots_node << c4::yml::key("diff-snapshots");
        snapshots_node |= c4::yml::SEQ;

        auto read_text = [](c4::yml::ConstNodeRef node) -> std::string {
            if (!node.has_val()) return {};
            c4::csubstr v = node.val();
            if (!v.str) return {};
            std::string_view trimmed =
                trim_view_right(trim_view_left(std::string_view{v.str, v.len}, is_no_space), is_no_newline);
            return std::string(trimmed);
        };

        auto tpl_snapshots = tpl_root["diff-snapshots"];
        for (auto test_node : tpl_snapshots.children()) {
            std::string name;
            if (test_node.has_child("name")) {
                c4::csubstr v = test_node["name"].val();
                if (v.str) name.assign(v.str, v.len);
            }
            std::string source_buffer = test_node.has_child("source") ? read_text(test_node["source"]) : std::string();
            std::string target_buffer = test_node.has_child("target") ? read_text(test_node["target"]) : std::string();
            std::cout << "  TEST " << name << std::endl;

            try {
                rope::Rope source_rope{1024, source_buffer};
                auto source_scanned = parser::Scanner::Scan(source_rope, 0, 1);
                auto source_parsed = parser::Parser::Parse(source_scanned);

                rope::Rope target_rope{1024, target_buffer};
                auto target_scanned = parser::Scanner::Scan(target_rope, 0, 2);
                auto target_parsed = parser::Parser::Parse(target_scanned);

                ScriptDiff diff{*source_parsed, *target_parsed};
                auto& ops = diff.Compute();

                auto item = snapshots_node.append_child();
                item.set_type(c4::yml::MAP);
                item.append_child() << c4::yml::key("name") << name;

                auto source_node = item.append_child();
                source_node << c4::yml::key("source") << source_buffer;
                source_node.set_val_style(c4::yml::VAL_LITERAL);
                auto target_node = item.append_child();
                target_node << c4::yml::key("target") << target_buffer;
                target_node.set_val_style(c4::yml::VAL_LITERAL);

                auto expected_node = item.append_child();
                expected_node << c4::yml::key("expected");
                expected_node |= c4::yml::MAP;
                DiffSnapshotTest::EncodeDiff(expected_node, ops, source_buffer, target_buffer);
            } catch (const dashql::Exception& e) {
                std::cout << "  ERROR " << buffers::status::EnumNameStatusCode(e.GetCode()) << std::endl;
                continue;
            }
        }

        c4::yml::NodeRef to_emit = out_tree.ref(out_tree.first_child(out_tree.root_id()));
        std::string emitted = c4::yml::emitrs_yaml<std::string>(to_emit, c4::yml::EmitOptions().max_depth(128));
        InjectBlankLinesInSnapshot(emitted);
        std::ofstream outs(out, std::ofstream::out | std::ofstream::trunc);
        outs << emitted;
    }
}

int main(int argc, char* argv[]) {
    gflags::SetUsageMessage("Usage: ./snapshotter --source_dir <dir> [--filter <category>]");
    gflags::ParseCommandLineFlags(&argc, &argv, false);

    if (!std::filesystem::exists(FLAGS_source_dir)) {
        std::cout << "Invalid source directory: " << FLAGS_source_dir << std::endl;
        return 1;
    }
    auto source_dir = std::filesystem::path{FLAGS_source_dir};
    const auto& f = FLAGS_filter;
    if (f.empty() || f == "parser") generate_parser_snapshots(source_dir / "snapshots" / "parser");
    if (f.empty() || f == "analyzer") generate_analyzer_snapshots(source_dir / "snapshots" / "analyzer");
    if (f.empty() || f == "planner") generate_planner_snapshots(source_dir / "snapshots" / "planner");
    if (f.empty() || f == "completion") generate_completion_snapshots(source_dir / "snapshots" / "completion");
    if (f.empty() || f == "formatter") generate_formatter_snapshots(source_dir / "snapshots" / "formatter");
    if (f.empty() || f == "hyper_plan")
        generate_hyper_plan_snapshots(source_dir / "snapshots" / "plans" / "hyper" / "tests");
    if (f.empty() || f == "visualize") generate_visualize_snapshots(source_dir / "snapshots" / "visualize");
    if (f.empty() || f == "diff") generate_diff_snapshots(source_dir / "snapshots" / "diff");
    return 0;
}
