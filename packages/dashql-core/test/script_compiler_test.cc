#include "dashql/script_compiler.h"

#include "dashql/catalog.h"
#include "dashql/script.h"
#include "dashql/visualize/markdown.h"
#include "gtest/gtest.h"

namespace dashql {
namespace {

buffers::formatting::FormattingConfigT ExecutionConfig() {
    buffers::formatting::FormattingConfigT config;
    config.mode = buffers::formatting::FormattingMode::INLINE;
    config.dialect = buffers::formatting::FormattingDialect::HYPER;
    config.max_width = 120;
    config.indentation_width = 2;
    return config;
}

ScriptCompilationResult Compile(std::string_view text, bool allow_extensions = true) {
    static Catalog catalog;
    Script script{catalog};
    script.InsertTextAt(0, text);
    return script.CompileQuery(ExecutionConfig(), {.allow_extensions = allow_extensions});
}

ScriptCompilationResult CompileWithAnalysis(std::string_view text) {
    static Catalog catalog;
    Script script{catalog};
    script.InsertTextAt(0, text);
    script.Parse();
    script.Analyze(false);
    return script.CompileQuery(ExecutionConfig(), {.allow_extensions = true, .parse_if_outdated = false});
}

TEST(ScriptCompilerTest, UsesStatementRangeWithoutTerminalSemicolon) {
    constexpr std::string_view sql = "  SELECT 1 AS x; -- preserve formatting\n";
    auto result = Compile(sql);

    ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
    EXPECT_EQ(result.kind, buffers::execution::ScriptCompilationStatementKind::QUERY);
    EXPECT_EQ(result.terminal_statement_id, 0);
    EXPECT_EQ(result.sql, "SELECT 1 AS x");
    ASSERT_EQ(result.statements.size(), 1);
    EXPECT_EQ(result.statements[0].sql, "SELECT 1 AS x");
    EXPECT_TRUE(result.cacheable);
    EXPECT_EQ(result.cache_signature.size(), 32);
}

TEST(ScriptCompilerTest, PreservesSemicolonsInSQLLiterals) {
    auto result = Compile("SELECT ';' AS value;");

    ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
    EXPECT_EQ(result.sql, "SELECT ';' AS value");
    ASSERT_EQ(result.statements.size(), 1);
    EXPECT_EQ(result.statements[0].sql, "SELECT ';' AS value");
}

TEST(ScriptCompilerTest, PassesUnparseableRemoteSQLThroughUncached) {
    constexpr std::string_view sql = "  SELECT * FROM remote_table QUALIFY row_number() OVER (PARTITION BY id) = 1;\n";
    auto result = Compile(sql);

    ASSERT_FALSE(result.errors.empty());
    EXPECT_EQ(result.errors.front().code, buffers::execution::ScriptCompilationErrorCode::PARSER_ERROR);
    EXPECT_EQ(result.kind, buffers::execution::ScriptCompilationStatementKind::QUERY);
    EXPECT_EQ(result.sql, sql);
    EXPECT_FALSE(result.cacheable);
    EXPECT_TRUE(result.cache_signature.empty());
    ASSERT_EQ(result.statements.size(), 1);
    EXPECT_EQ(result.statements[0].kind, buffers::execution::CompiledScriptStatementKind::OUTPUT);
    EXPECT_EQ(result.statements[0].sql, sql);
}

TEST(ScriptCompilerTest, ClassifiesInsertAsQuery) {
    constexpr std::string_view sql = "INSERT INTO target VALUES (1);";
    auto result = Compile(sql);

    ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
    EXPECT_EQ(result.kind, buffers::execution::ScriptCompilationStatementKind::QUERY);
    EXPECT_EQ(result.terminal_statement_id, 0);
    EXPECT_EQ(result.sql, "INSERT INTO target VALUES (1)");
    EXPECT_FALSE(result.cacheable);
}

TEST(ScriptCompilerTest, ComputesSemanticCacheSignature) {
    auto compact = Compile("CREATE TABLE t(a INT); SELECT a FROM t WHERE a = 1");
    auto formatted = Compile("-- setup\ncreate table t ( a int );\n/* query */ select A from T where A=1;");
    auto different_prefix = Compile("CREATE TABLE t(a BIGINT); SELECT a FROM t WHERE a = 1");
    auto different_query = Compile("CREATE TABLE t(a INT); SELECT a FROM t WHERE a = 2");

    ASSERT_TRUE(compact.errors.empty());
    ASSERT_TRUE(formatted.errors.empty());
    EXPECT_TRUE(compact.cacheable);
    EXPECT_EQ(compact.cache_signature, formatted.cache_signature);
    EXPECT_NE(compact.cache_signature, different_prefix.cache_signature);
    EXPECT_NE(compact.cache_signature, different_query.cache_signature);
}

TEST(ScriptCompilerTest, ClassifiesDeleteCommandsAndReturningOutputsWithoutCaching) {
    for (auto sql : {"DELETE FROM target WHERE id = 1;",
                     "WITH ids AS (SELECT 1 AS id) DELETE FROM target USING ids WHERE target.id = ids.id;",
                     "DELETE FROM target RETURNING *;",
                     "DELETE FROM target RETURNING (SELECT id FROM source) AS deleted_id;"}) {
        SCOPED_TRACE(sql);
        auto result = Compile(sql);
        ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
        ASSERT_EQ(result.statements.size(), 1u);
        EXPECT_EQ(result.kind, buffers::execution::ScriptCompilationStatementKind::QUERY);
        EXPECT_EQ(result.statements[0].statement_type, buffers::parser::StatementType::DELETE);
        EXPECT_EQ(result.statements[0].kind, std::string_view{sql}.find("RETURNING") != std::string_view::npos
                                                 ? buffers::execution::CompiledScriptStatementKind::OUTPUT
                                                 : buffers::execution::CompiledScriptStatementKind::COMMAND);
        EXPECT_EQ(result.sql, std::string_view{sql}.substr(0, std::string_view{sql}.size() - 1));
        EXPECT_FALSE(result.cacheable);
        EXPECT_EQ(result.cache_signature.size(), 32u);
    }
}

TEST(ScriptCompilerTest, AllowsDeletePrefixButRejectsNonterminalDeleteReturning) {
    auto commands = Compile("DELETE FROM target WHERE id = 1; SELECT * FROM target;");
    ASSERT_TRUE(commands.errors.empty());
    ASSERT_EQ(commands.statements.size(), 2u);
    EXPECT_EQ(commands.statements[0].kind, buffers::execution::CompiledScriptStatementKind::COMMAND);
    EXPECT_EQ(commands.statements[1].kind, buffers::execution::CompiledScriptStatementKind::OUTPUT);

    auto returning = Compile("DELETE FROM target RETURNING id; SELECT 1;");
    ASSERT_EQ(returning.errors.size(), 1u);
    EXPECT_EQ(returning.errors[0].code, buffers::execution::ScriptCompilationErrorCode::OUTPUT_STATEMENT_NOT_LAST);
    EXPECT_EQ(returning.errors[0].statement_id, 0u);
}

TEST(ScriptCompilerTest, ExcludesTerminalVisualizationFromCacheSignature) {
    auto select = Compile("SELECT value FROM metrics");
    auto bars = Compile("SELECT value FROM metrics VISUALIZE USING vegalite (mark => bar)");
    auto lines = Compile("SELECT value FROM metrics VISUALIZE USING vegalite (mark => line)");
    auto markdown = Compile("SELECT value FROM metrics VISUALIZE USING markdown (template => '{{value}}')");

    ASSERT_TRUE(select.errors.empty());
    ASSERT_TRUE(bars.errors.empty());
    ASSERT_TRUE(lines.errors.empty());
    ASSERT_TRUE(markdown.errors.empty());
    EXPECT_TRUE(bars.cacheable);
    EXPECT_EQ(select.cache_signature, bars.cache_signature);
    EXPECT_EQ(bars.cache_signature, lines.cache_signature);
    EXPECT_EQ(lines.cache_signature, markdown.cache_signature);
}

TEST(ScriptCompilerTest, CachesExplainButNotCreateStatements) {
    auto explain = Compile("EXPLAIN CREATE TABLE t(a INT)");
    auto create_table = Compile("CREATE TABLE t(a INT)");
    auto create_view = Compile("CREATE VIEW v AS SELECT 1");

    ASSERT_TRUE(explain.errors.empty());
    ASSERT_TRUE(create_table.errors.empty());
    ASSERT_TRUE(create_view.errors.empty());
    EXPECT_TRUE(explain.cacheable);
    EXPECT_FALSE(create_table.cacheable);
    EXPECT_FALSE(create_view.cacheable);
}

TEST(ScriptCompilerTest, CompilesStatementsInOrder) {
    auto result = Compile("CREATE TABLE t (v INT); INSERT INTO t VALUES (1); SELECT * FROM t;");

    ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
    ASSERT_EQ(result.statements.size(), 3);
    EXPECT_EQ(result.statements[0].kind, buffers::execution::CompiledScriptStatementKind::COMMAND);
    EXPECT_EQ(result.statements[0].sql, "CREATE TABLE t (v INT)");
    EXPECT_EQ(result.statements[1].sql, "INSERT INTO t VALUES (1)");
    EXPECT_EQ(result.statements[2].kind, buffers::execution::CompiledScriptStatementKind::OUTPUT);
    EXPECT_EQ(result.statements[2].sql, "SELECT * FROM t");
    EXPECT_EQ(result.sql, "SELECT * FROM t");
}

TEST(ScriptCompilerTest, RejectsOutputStatementBeforeEnd) {
    auto result = Compile("SELECT 1; CREATE TABLE t (v INT);");

    ASSERT_EQ(result.errors.size(), 1);
    EXPECT_EQ(result.errors.front().code,
              buffers::execution::ScriptCompilationErrorCode::OUTPUT_STATEMENT_NOT_LAST);
    EXPECT_EQ(result.errors.front().statement_id, 0);
}

TEST(ScriptCompilerTest, AllowsCommandOnlyScript) {
    auto result = Compile("SET x = 1; CREATE TABLE t (v INT);");

    ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
    ASSERT_EQ(result.statements.size(), 2);
    EXPECT_EQ(result.statements[1].kind, buffers::execution::CompiledScriptStatementKind::COMMAND);
}

TEST(ScriptCompilerTest, TreatsInsertReturningAndSelectIntoAsOutput) {
    auto insert = Compile("INSERT INTO t VALUES (1) RETURNING *;");
    ASSERT_TRUE(insert.errors.empty()) << (insert.errors.empty() ? "" : insert.errors.front().message);
    ASSERT_EQ(insert.statements.size(), 1);
    EXPECT_EQ(insert.statements[0].kind, buffers::execution::CompiledScriptStatementKind::OUTPUT);

    auto select_into = Compile("SELECT 1 INTO t;");
    ASSERT_TRUE(select_into.errors.empty())
        << (select_into.errors.empty() ? "" : select_into.errors.front().message);
    ASSERT_EQ(select_into.statements.size(), 1);
    EXPECT_EQ(select_into.statements[0].kind, buffers::execution::CompiledScriptStatementKind::OUTPUT);
}

TEST(ScriptCompilerTest, CompilesTrailingVisualization) {
    auto result = Compile(R"SQL(
WITH source AS (SELECT category, amount FROM sales)
SELECT category, sum(amount) AS total
FROM source
GROUP BY category
ORDER BY total DESC
LIMIT 10
VISUALIZE USING vegalite (
    mark => bar,
    encoding => (
        x => (field => category, type => nominal),
        y => (field => total, type => quantitative)
    )
);
)SQL");

    ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
    EXPECT_EQ(result.kind, buffers::execution::ScriptCompilationStatementKind::VISUALIZE);
    EXPECT_EQ(result.terminal_statement_id, 0);
    EXPECT_NE(result.sql.find("with source as"), std::string::npos) << result.sql;
    EXPECT_NE(result.sql.find("order by total desc limit 10"), std::string::npos) << result.sql;
    EXPECT_EQ(result.sql.find("visualize"), std::string::npos) << result.sql;
    EXPECT_FALSE(result.sql.ends_with(';'));
    ASSERT_TRUE(result.visualization.has_value());
    EXPECT_EQ(result.visualization->renderer, "vegalite");
    EXPECT_FALSE(result.visualization->vegalite_spec.empty());
    ASSERT_EQ(result.statements.size(), 1);
    EXPECT_EQ(result.statements[0].kind, buffers::execution::CompiledScriptStatementKind::VISUALIZE);
}

TEST(ScriptCompilerTest, CompilesUmapVisualization) {
    auto result = Compile(R"SQL(
SELECT embedding, cluster_id FROM embeddings
VISUALIZE USING umap (
    vector => embedding,
    category => cluster_id,
    neighbors => 15,
    min_dist => 0.1,
    metric => cosine
);
)SQL");

    ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
    ASSERT_TRUE(result.visualization.has_value());
    EXPECT_EQ(result.visualization->renderer, "umap");
    ASSERT_NE(result.visualization->umap_spec, nullptr);
    EXPECT_EQ(result.visualization->umap_spec->vector_column, "embedding");
    EXPECT_EQ(result.visualization->umap_spec->category_column, "cluster_id");
    ASSERT_NE(result.visualization->umap_spec->projection, nullptr);
    EXPECT_EQ(result.visualization->umap_spec->projection->metric, "cosine");
    EXPECT_EQ(result.visualization->umap_spec->projection->neighbors, 15);
    EXPECT_DOUBLE_EQ(*result.visualization->umap_spec->projection->min_dist, 0.1);
    EXPECT_EQ(result.sql.find("visualize"), std::string::npos);

    flatbuffers::FlatBufferBuilder builder;
    builder.Finish(result.Pack(builder));
    auto* packed = flatbuffers::GetRoot<buffers::execution::ScriptCompilationResult>(builder.GetBufferPointer());
    ASSERT_NE(packed->visualization(), nullptr);
    ASSERT_NE(packed->visualization()->umap_spec(), nullptr);
    auto* packed_umap = packed->visualization()->umap_spec();
    EXPECT_EQ(packed_umap->vector_column()->string_view(), "embedding");
    EXPECT_EQ(packed_umap->category_column()->string_view(), "cluster_id");
    ASSERT_NE(packed_umap->projection(), nullptr);
    EXPECT_EQ(packed_umap->projection()->metric()->string_view(), "cosine");
    EXPECT_EQ(packed_umap->projection()->neighbors(), 15);
    EXPECT_DOUBLE_EQ(*packed_umap->projection()->min_dist(), 0.1);
}

TEST(ScriptCompilerTest, CompilesMarkdownVisualization) {
    auto result = Compile(R"SQL(
SELECT product, revenue
FROM product_summary
VISUALIZE USING markdown (
    template => '## {{product}}: {{revenue}}'
)
)SQL");

    ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
    EXPECT_EQ(result.kind, buffers::execution::ScriptCompilationStatementKind::VISUALIZE);
    ASSERT_TRUE(result.visualization.has_value());
    EXPECT_EQ(result.visualization->renderer, "markdown");
    EXPECT_NE(result.sql.find("select product, revenue"), std::string::npos);
    EXPECT_EQ(result.sql.find("visualize"), std::string::npos);
    ASSERT_NE(result.visualization->markdown_spec, nullptr);
    EXPECT_EQ(result.visualization->markdown_spec->fields,
              (std::vector<std::string>{"product", "revenue"}));

    flatbuffers::FlatBufferBuilder builder;
    builder.Finish(result.Pack(builder));
    auto* packed = flatbuffers::GetRoot<buffers::execution::ScriptCompilationResult>(builder.GetBufferPointer());
    ASSERT_NE(packed->visualization(), nullptr);
    EXPECT_TRUE(packed->visualization()->vegalite_spec()->string_view().empty());
    ASSERT_NE(packed->visualization()->markdown_spec(), nullptr);
    auto* packed_markdown = packed->visualization()->markdown_spec();
    EXPECT_EQ(packed_markdown->fields()->size(), 2u);
    ASSERT_NE(packed_markdown->document(), nullptr);
    EXPECT_EQ(packed_markdown->document()->node_type(), buffers::visualization::MarkdownNodeType::DOCUMENT);
    ASSERT_EQ(packed_markdown->document()->children()->size(), 1u);
    EXPECT_EQ(packed_markdown->document()->children()->Get(0)->node_type(),
              buffers::visualization::MarkdownNodeType::HEADING);
}

TEST(ScriptCompilerTest, CompilesTableVisualizationWithDashboardLayout) {
    auto result = CompileWithAnalysis(R"SQL(
SELECT product, revenue
FROM product_summary
VISUALIZE USING table (
    dashboard => (row => 2, column => 4, width => 8, height => 5)
)
)SQL");

    ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
    ASSERT_TRUE(result.visualization.has_value());
    EXPECT_EQ(result.visualization->renderer, "table");
    ASSERT_NE(result.visualization->table_spec, nullptr);
    ASSERT_NE(result.visualization->dashboard, nullptr);
    EXPECT_EQ(result.visualization->dashboard->row, 2);
    EXPECT_EQ(result.visualization->dashboard->column, 4);
    EXPECT_EQ(result.visualization->dashboard->width, 8);
    EXPECT_EQ(result.visualization->dashboard->height, 5);

    flatbuffers::FlatBufferBuilder builder;
    builder.Finish(result.Pack(builder));
    auto* packed = flatbuffers::GetRoot<buffers::execution::ScriptCompilationResult>(builder.GetBufferPointer());
    ASSERT_NE(packed->visualization(), nullptr);
    ASSERT_NE(packed->visualization()->dashboard(), nullptr);
    ASSERT_NE(packed->visualization()->table_spec(), nullptr);
    ASSERT_TRUE(packed->visualization()->dashboard()->row().has_value());
    EXPECT_EQ(*packed->visualization()->dashboard()->row(), 2);
    ASSERT_TRUE(packed->visualization()->dashboard()->column().has_value());
    EXPECT_EQ(*packed->visualization()->dashboard()->column(), 4);
    EXPECT_EQ(packed->visualization()->dashboard()->width(), 8);
    EXPECT_EQ(packed->visualization()->dashboard()->height(), 5);
}

TEST(ScriptCompilerTest, RendererCaseNormalizationCompilesTerminalMetadataWithoutMutatingNativeState) {
    Catalog catalog;
    struct Case {
        std::string_view renderer;
        std::string_view normalized;
        std::string_view options;
    };
    for (auto test : {Case{"TABLE", "table", "()"}, Case{"TaBlE", "table", "()"},
                      Case{"VEGALITE", "vegalite", "(mark => bar)"},
                      Case{"VeGaLiTe", "vegalite", "(mark => bar)"},
                      Case{"UMAP", "umap", "(vector => embedding, label => label)"},
                      Case{"UmAp", "umap", "(vector => embedding, label => label)"},
                      Case{"MARKDOWN", "markdown", "(template => '## {{label}}')"},
                      Case{"MaRkDoWn", "markdown", "(template => '## {{label}}')"}}) {
        SCOPED_TRACE(test.renderer);
        auto sql = "create table embeddings (embedding int, label text); "
                   "select embedding, label from embeddings visualize using " + std::string{test.renderer} +
                   " " + std::string{test.options};
        Script script{catalog};
        script.ReplaceText(sql);
        script.Parse();
        script.Analyze(false);
        auto analyzed = script.GetAnalyzedScript();
        auto parsed = script.GetParsedScript();
        ASSERT_TRUE(parsed->errors.empty());
        auto version = catalog.GetVersion();
        auto text_version = script.text_version;
        ASSERT_EQ(analyzed->visualization_specs.GetSize(), 1);
        auto check_analysis = [&] {
            analyzed->visualization_specs.ForEach([&](size_t, const VisualizationSpec& spec) {
                ASSERT_TRUE(spec.renderer.has_value());
                EXPECT_EQ(*spec.renderer, test.renderer);
            });
        };
        check_analysis();
        auto result = script.CompileQuery(ExecutionConfig(), {.allow_extensions = true, .parse_if_outdated = false});
        ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
        EXPECT_EQ(result.kind, buffers::execution::ScriptCompilationStatementKind::VISUALIZE);
        EXPECT_EQ(result.terminal_statement_id, 1);
        EXPECT_EQ(result.sql, "select embedding, label from embeddings");
        ASSERT_EQ(result.statements.size(), 2);
        EXPECT_EQ(result.statements[0].kind, buffers::execution::CompiledScriptStatementKind::COMMAND);
        EXPECT_EQ(result.statements[1].kind, buffers::execution::CompiledScriptStatementKind::VISUALIZE);
        ASSERT_TRUE(result.statements[1].visualization.has_value());
        EXPECT_EQ(result.statements[1].visualization->renderer, test.normalized);
        ASSERT_TRUE(result.visualization.has_value());
        auto& visualization = *result.visualization;
        EXPECT_EQ(visualization.renderer, test.normalized);
        if (test.normalized == "table") ASSERT_NE(visualization.table_spec, nullptr);
        if (test.normalized == "vegalite") EXPECT_NE(visualization.vegalite_spec.find("\"bar\""), std::string::npos);
        if (test.normalized == "umap") {
            ASSERT_NE(visualization.umap_spec, nullptr);
            EXPECT_EQ(visualization.umap_spec->vector_column, "embedding");
            EXPECT_EQ(visualization.umap_spec->label_column, "label");
        }
        if (test.normalized == "markdown") {
            ASSERT_NE(visualization.markdown_spec, nullptr);
            EXPECT_EQ(visualization.markdown_spec->template_, "## {{label}}");
            EXPECT_EQ(visualization.markdown_spec->fields, (std::vector<std::string>{"label"}));
            ASSERT_NE(visualization.markdown_spec->document, nullptr);
        }
        flatbuffers::FlatBufferBuilder builder;
        builder.Finish(result.Pack(builder));
        auto* packed = flatbuffers::GetRoot<buffers::execution::ScriptCompilationResult>(builder.GetBufferPointer());
        ASSERT_NE(packed->visualization(), nullptr);
        EXPECT_EQ(packed->visualization()->renderer()->string_view(), test.normalized);
        ASSERT_NE(packed->statements()->Get(1)->visualization(), nullptr);
        EXPECT_EQ(packed->statements()->Get(1)->visualization()->renderer()->string_view(), test.normalized);
        EXPECT_EQ(script.ToString(), sql);
        EXPECT_EQ(script.text_version, text_version);
        EXPECT_EQ(script.GetParsedScript(), parsed);
        EXPECT_EQ(script.GetAnalyzedScript(), analyzed);
        EXPECT_EQ(catalog.GetVersion(), version);
        check_analysis();
    }
}

TEST(ScriptCompilerTest, DefaultsDashboardLayout) {
    auto result = CompileWithAnalysis("SELECT 1 AS value VISUALIZE USING table ();");

    ASSERT_TRUE(result.errors.empty()) << (result.errors.empty() ? "" : result.errors.front().message);
    ASSERT_TRUE(result.visualization.has_value());
    ASSERT_NE(result.visualization->dashboard, nullptr);
    EXPECT_FALSE(result.visualization->dashboard->row.has_value());
    EXPECT_FALSE(result.visualization->dashboard->column.has_value());
    EXPECT_EQ(result.visualization->dashboard->width, 6);
    EXPECT_EQ(result.visualization->dashboard->height, 3);
}

TEST(ScriptCompilerTest, RejectsVisualizationWhenExtensionsDisabled) {
    auto result = Compile(
        "SELECT 1 AS value VISUALIZE USING vegalite (mark => bar, encoding => (x => (field => value)));",
        false);

    ASSERT_EQ(result.errors.size(), 1);
    EXPECT_EQ(result.errors.front().code, buffers::execution::ScriptCompilationErrorCode::EXTENSIONS_DISABLED);
}

TEST(ScriptCompilerTest, PassesUnparseablePipeSyntaxThrough) {
    auto result = Compile("SELECT * FROM sales |> VISUALIZE USING vegalite (mark => bar);");
    ASSERT_FALSE(result.errors.empty());
    EXPECT_EQ(result.errors.front().code, buffers::execution::ScriptCompilationErrorCode::PARSER_ERROR);
    EXPECT_EQ(result.sql, "SELECT * FROM sales |> VISUALIZE USING vegalite (mark => bar);");
    EXPECT_FALSE(result.cacheable);
}

}  // namespace
}  // namespace dashql
