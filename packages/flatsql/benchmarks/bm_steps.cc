#include "benchmark/benchmark.h"
#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/names.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/script.h"
#include "flatsql/text/rope.h"
#include "flatsql/utils/suffix_trie.h"
#include "flatsql/vis/schema_graph.h"

using namespace flatsql;

static const std::string_view external_script = R"SQL(
create table part (p_partkey integer not null, p_name varchar(55) not null, p_mfgr char(25) not null, p_brand char(10) not null, p_type varchar(25) not null, p_size integer not null, p_container char(10) not null, p_retailprice decimal(12,2) not null, p_comment varchar(23) not null, primary key (p_partkey));
create table supplier (s_suppkey integer not null, s_name char(25) not null, s_address varchar(40) not null, s_nationkey integer not null, s_phone char(15) not null, s_acctbal decimal(12,2) not null, s_comment varchar(101) not null, primary key (s_suppkey));
create table partsupp (ps_partkey integer not null, ps_suppkey integer not null, ps_availqty integer not null, ps_supplycost decimal(12,2) not null, ps_comment varchar(199) not null, primary key (ps_partkey,ps_suppkey));
create table customer (c_custkey integer not null, c_name varchar(25) not null, c_address varchar(40) not null, c_nationkey integer not null, c_phone char(15) not null, c_acctbal decimal(12,2) not null, c_mktsegment char(10) not null, c_comment varchar(117) not null, primary key (c_custkey));
create table orders (o_orderkey integer not null, o_custkey integer not null, o_orderstatus char(1) not null, o_totalprice decimal(12,2) not null, o_orderdate date not null, o_orderpriority char(15) not null, o_clerk char(15) not null, o_shippriority integer not null, o_comment varchar(79) not null, primary key (o_orderkey));
create table lineitem (l_orderkey integer not null, l_partkey integer not null, l_suppkey integer not null, l_linenumber integer not null, l_quantity decimal(12,2) not null, l_extendedprice decimal(12,2) not null, l_discount decimal(12,2) not null, l_tax decimal(12,2) not null, l_returnflag char(1) not null, l_linestatus char(1) not null, l_shipdate date not null, l_commitdate date not null, l_receiptdate date not null, l_shipinstruct char(25) not null, l_shipmode char(10) not null, l_comment varchar(44) not null, primary key (l_orderkey,l_linenumber));
create table nation (n_nationkey integer not null, n_name char(25) not null, n_regionkey integer not null, n_comment varchar(152) not null, primary key (n_nationkey));
create table region (r_regionkey integer not null, r_name char(25) not null, r_comment varchar(152) not null, primary key (r_regionkey));
)SQL";

static const std::string_view main_script = R"SQL(
select
        s_acctbal,
        s_name,
        n_name,
        p_partkey,
        p_mfgr,
        s_address,
        s_phone,
        s_comment
from
        part,
        supplier,
        partsupp,
        nation,
        region
where
        p_partkey = ps_partkey
        and s_suppkey = ps_suppkey
        and p_size = 15
        and p_type like '%BRASS'
        and s_nationkey = n_nationkey
        and n_regionkey = r_regionkey
        and r_name = 'EUROPE'
        and ps_supplycost = (
                select
                        min(ps_supplycost)
                from
                        partsupp,
                        supplier,
                        nation,
                        region
                where
                        p_partkey = ps_partkey
                        and s_suppkey = ps_suppkey
                        and s_nationkey = n_nationkey
                        and n_regionkey = r_regionkey
                        and r_name = 'EUROPE'
        )
order by
        s_acctbal desc,
        n_name,
        s_name,
        p_partkey
limit
	100
)SQL";

static void scan_query(benchmark::State& state) {
    rope::Rope buffer{1024, main_script};
    for (auto _ : state) {
        auto scan = flatsql::parser::Scanner::Scan(buffer, 0);
        benchmark::DoNotOptimize(scan);
    }
}

static void parse_query(benchmark::State& state) {
    rope::Rope buffer{1024, main_script};
    auto scanner = flatsql::parser::Scanner::Scan(buffer, 0);
    for (auto _ : state) {
        auto parsed = flatsql::parser::ParseContext::Parse(scanner.first);
        benchmark::DoNotOptimize(parsed);
    }
}

static void analyze_query(benchmark::State& state) {
    rope::Rope input_external{1024, external_script};
    rope::Rope input_main{1024, main_script};

    // Analyze external script
    auto external_scan = parser::Scanner::Scan(input_external, 0);
    auto external_parsed = parser::ParseContext::Parse(external_scan.first);
    auto external_analyzed = Analyzer::Analyze(external_parsed.first, nullptr);

    // Parse script
    auto main_scan = parser::Scanner::Scan(input_main, 1);
    auto main_parsed = parser::ParseContext::Parse(main_scan.first);

    for (auto _ : state) {
        auto main_analyzed = Analyzer::Analyze(main_parsed.first, external_analyzed.first);
        benchmark::DoNotOptimize(main_analyzed);
    }
}

static void index_query_sorting(benchmark::State& state) {
    rope::Rope input_external{1024, external_script};
    rope::Rope input_main{1024, main_script};

    // Analyze external script
    auto external_scan = parser::Scanner::Scan(input_external, 0);
    auto external_parsed = parser::ParseContext::Parse(external_scan.first);
    auto external_analyzed = Analyzer::Analyze(external_parsed.first, nullptr);

    // Parse script
    auto main_scan = parser::Scanner::Scan(input_main, 1);
    auto main_parsed = parser::ParseContext::Parse(main_scan.first);
    auto main_analyzed = Analyzer::Analyze(main_parsed.first, nullptr);

    for (auto _ : state) {
        std::span<const ScannedScript::Name> names{main_scan.first->name_dictionary};
        std::vector<SuffixTrie::Entry> entries;
        {
            ChunkBuffer<SuffixTrie::Entry, 256> entries_chunked;
            for (size_t i = 0; i < names.size(); ++i) {
                auto& value = names[i];
                SuffixTrie::Entry entry = SuffixTrie::Entry{value.text, i, proto::NameTag::KEYWORD};
                auto text = entry.suffix;
                for (size_t offset = 0; offset < text.size(); ++offset) {
                    auto copy = entry;
                    copy.suffix = text.substr(offset);
                    entries_chunked.Append(copy);
                }
            }
            entries = entries_chunked.Flatten();
        }
        std::sort(entries.begin(), entries.end(),
                  [](SuffixTrie::Entry& l, SuffixTrie::Entry& r) { return l.suffix < r.suffix; });
        benchmark::DoNotOptimize(entries);
    }
}

static void index_query_bulkloading(benchmark::State& state) {
    rope::Rope input_external{1024, external_script};
    rope::Rope input_main{1024, main_script};

    // Analyze external script
    auto external_scan = parser::Scanner::Scan(input_external, 0);
    auto external_parsed = parser::ParseContext::Parse(external_scan.first);
    auto external_analyzed = Analyzer::Analyze(external_parsed.first, nullptr);

    // Parse script
    auto main_scan = parser::Scanner::Scan(input_main, 1);
    auto main_parsed = parser::ParseContext::Parse(main_scan.first);
    auto main_analyzed = Analyzer::Analyze(main_parsed.first, nullptr);

    std::span<const ScannedScript::Name> names{main_scan.first->name_dictionary};
    std::vector<SuffixTrie::Entry> entries;
    {
        ChunkBuffer<SuffixTrie::Entry, 256> entries_chunked;
        for (size_t i = 0; i < names.size(); ++i) {
            auto& value = names[i];
            SuffixTrie::Entry entry = SuffixTrie::Entry{value.text, i, proto::NameTag::KEYWORD};
            auto text = entry.suffix;
            for (size_t offset = 0; offset < text.size(); ++offset) {
                auto copy = entry;
                copy.suffix = text.substr(offset);
                entries_chunked.Append(copy);
            }
        }
        entries = entries_chunked.Flatten();
    }
    std::sort(entries.begin(), entries.end(),
              [](SuffixTrie::Entry& l, SuffixTrie::Entry& r) { return l.suffix < r.suffix; });

    for (auto _ : state) {
        std::span<const ScannedScript::Name> names{main_scan.first->name_dictionary};
        auto trie = SuffixTrie::BulkLoad(entries);
        benchmark::DoNotOptimize(trie);
    }
}

static void layout_schema(benchmark::State& state) {
    rope::Rope input_external{1024, external_script};

    // Analyze external script
    auto external_scan = parser::Scanner::Scan(input_external, 0);
    auto external_parsed = parser::ParseContext::Parse(external_scan.first);
    auto external_analyzed = Analyzer::Analyze(external_parsed.first, nullptr);

    SchemaGraph graph;

    SchemaGraph::Config config;
    config.iterations_clustering = 10;
    config.iterations_refinement = 10;
    config.force_scaling = 1.0;
    config.cooldown_factor = 0.85;
    config.repulsion_force = 15.0;
    config.edge_attraction_force = 15.0;
    config.gravity_force = 15.0;
    config.board_width = 1600;
    config.board_height = 800;
    config.table_width = 100;
    config.table_height = 24;
    config.table_margin = 20;

    for (auto _ : state) {
        graph.Configure(config);
        graph.LoadScript(external_analyzed.first);
    }
}

BENCHMARK(scan_query);
BENCHMARK(parse_query);
BENCHMARK(analyze_query);
BENCHMARK(index_query_sorting);
BENCHMARK(index_query_bulkloading);
BENCHMARK(layout_schema);
BENCHMARK_MAIN();
