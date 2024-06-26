#include "sqlynx/vis/query_graph_layout.h"

#include <limits>

#include "sqlynx/api.h"
#include "sqlynx/catalog.h"
#include "sqlynx/external.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

namespace sqlynx {

namespace {

constexpr size_t NULL_TABLE_ID = std::numeric_limits<uint32_t>::max();

/// Get the score
constexpr double GetScore(double distance, uint8_t neighbor_count) {
    QueryGraphLayout::Position base;
    return -1.0 * distance + (static_cast<double>(neighbor_count) * (base.distance_to(base.north_east())));
}

}  // namespace

QueryGraphLayout::QueryGraphLayout() {}

void QueryGraphLayout::Clear() {
    script = nullptr;
    adjacency.adjacency_nodes.clear();
    adjacency.adjacency_offsets.clear();
    edge_nodes.clear();
    edges.clear();
    nodes.clear();
    cells_by_position.clear();
    cells_by_table.clear();
    free_cells.clear();
    free_cells.clear();
    unplaced_nodes.Clear();
}

proto::StatusCode QueryGraphLayout::Configure(const QueryGraphLayout::Config& c) {
    Clear();
    config = c;
    return proto::StatusCode::OK;
}

void QueryGraphLayout::PrepareLayout(const AnalyzedScript& analyzed) {
    // Internal and external tables
    size_t table_count = analyzed.GetTables().GetSize();
    script->GetCatalog().Iterate(
        [&](auto entry_id, CatalogEntry& entry) { table_count += entry.GetTables().GetSize(); });
    // Load adjacency map
    assert(nodes.empty());
    nodes.reserve(table_count);
    // Load internal tables
    std::unordered_map<ExternalObjectID, size_t, ExternalObjectID::Hasher> nodes_by_table_id;
    for (auto& table : analyzed.GetTables()) {
        nodes_by_table_id.insert({table.table_id, nodes.size()});
        nodes.emplace_back(nodes.size(), table.table_id, table.table_name, 0);
    }
    // Add external tables
    script->GetCatalog().Iterate([&](auto entry_id, CatalogEntry& entry) {
        for (auto& table : entry.GetTables()) {
            nodes_by_table_id.insert({table.table_id, nodes.size()});
            nodes.emplace_back(nodes.size(), table.table_id, table.table_name, 0);
        }
    });
    for (auto& ref : analyzed.table_references) {
        if (auto iter = nodes_by_table_id.find(ref.resolved_table_id); iter != nodes_by_table_id.end()) {
            nodes[iter->second].table_reference_id = ref.table_reference_id;
        }
    }
    // Add edge node ids
    assert(edge_nodes.empty());
    edge_nodes.resize(analyzed.graph_edge_nodes.size());
    for (size_t i = 0; i < analyzed.graph_edge_nodes.size(); ++i) {
        const AnalyzedScript::QueryGraphEdgeNode& node = analyzed.graph_edge_nodes[i];
        ExternalObjectID column_reference_id{script->GetExternalID(), node.column_reference_id};
        auto& col_ref = analyzed.column_references[node.column_reference_id];
        ExternalObjectID ast_node_id = col_ref.ast_node_id.has_value()
                                           ? ExternalObjectID{script->GetExternalID(), *col_ref.ast_node_id}
                                           : ExternalObjectID{};
        ExternalObjectID table_id = analyzed.column_references[node.column_reference_id].resolved_table_id;
        uint32_t node_id = std::numeric_limits<uint32_t>::max();
        if (auto iter = nodes_by_table_id.find(table_id); iter != nodes_by_table_id.end()) {
            node_id = iter->second;
        }
        edge_nodes[i] = EdgeNode{column_reference_id, ast_node_id, table_id, node_id};
    }
    // Add edges
    assert(edges.empty());
    edges.resize(analyzed.graph_edges.size());
    for (uint32_t i = 0; i < analyzed.graph_edges.size(); ++i) {
        const AnalyzedScript::QueryGraphEdge& edge = analyzed.graph_edges[i];
        edges[i] = {ExternalObjectID{script->GetExternalID(), i},
                    edge.ast_node_id.has_value() ? ExternalObjectID{script->GetExternalID(), *edge.ast_node_id}
                                                 : ExternalObjectID{},
                    edge.nodes_begin,
                    edge.node_count_left,
                    edge.node_count_right,
                    edge.expression_operator};
    }
    // Collect nˆ2 adjacency pairs for now.
    // We might want to model hyper-edges differently for edge attraction in the future
    std::vector<std::pair<size_t, size_t>> adjacency_pairs;
    for (size_t i = 0; i < analyzed.graph_edges.size(); ++i) {
        const AnalyzedScript::QueryGraphEdge& edge = analyzed.graph_edges[i];
        // Emit nˆ2 adjacency pairs with patched node ids
        for (size_t l = 0; l < edge.node_count_left; ++l) {
            size_t lcol = analyzed.graph_edge_nodes[edge.nodes_begin + l].column_reference_id;
            ExternalObjectID ltid = analyzed.column_references[lcol].resolved_table_id;
            auto iter = nodes_by_table_id.find(ltid);
            if (iter == nodes_by_table_id.end()) {
                continue;
            }
            auto ln = iter->second;
            // Emit pair for each right node
            for (size_t r = 0; r < edge.node_count_right; ++r) {
                size_t rcol =
                    analyzed.graph_edge_nodes[edge.nodes_begin + edge.node_count_left + r].column_reference_id;
                ExternalObjectID rtid = analyzed.column_references[rcol].resolved_table_id;
                if (rtid.IsNull()) continue;
                auto iter = nodes_by_table_id.find(rtid);
                if (iter == nodes_by_table_id.end()) {
                    continue;
                }
                auto rn = iter->second;
                adjacency_pairs.emplace_back(ln, rn);
                nodes[ln].total_peers += 1;
                nodes[rn].total_peers += 1;
            }
        }
    }
    // Build adjacency map
    assert(adjacency.adjacency_nodes.empty());
    assert(adjacency.adjacency_offsets.empty());
    adjacency.adjacency_offsets.clear();
    adjacency.adjacency_offsets.reserve(nodes.size() + 1);
    adjacency.adjacency_nodes.clear();
    adjacency.adjacency_nodes.reserve(adjacency_pairs.size());
    std::sort(adjacency_pairs.begin(), adjacency_pairs.end());
    size_t i = 0;
    for (auto begin = adjacency_pairs.begin(); begin != adjacency_pairs.end();) {
        for (; i <= begin->first; ++i) {
            adjacency.adjacency_offsets.push_back(adjacency.adjacency_nodes.size());
        }
        auto in_partition = [&](auto& adj) { return adj.first == begin->first; };
        auto end = std::partition_point(begin + 1, adjacency_pairs.end(), in_partition);
        for (auto iter = begin; iter != end; ++iter) {
            adjacency.adjacency_nodes.push_back(iter->second);
        }
        begin = end;
    }
    for (; i <= nodes.size(); ++i) {
        adjacency.adjacency_offsets.push_back(adjacency.adjacency_nodes.size());
    }
    adjacency_pairs = {};

    // Collect unplaced nodes
    std::vector<Node::Ref> node_refs;
    node_refs.reserve(nodes.size());
    for (auto& node : nodes) {
        node_refs.emplace_back(node);
    }
    unplaced_nodes = {std::move(node_refs)};

    // Add first free cell
    if (nodes.size() == 1) {
        // Center cell if there's only a single node
        Position initial_cell_pos{0, 0};
        Cell initial_cell{initial_cell_pos, 0};
        free_cells.push_back(initial_cell);
        cells_by_position.insert({initial_cell_pos, initial_cell});
    } else {
        // Move cell slightly to the left with more than one node (s.t. the next node will be placed to the right)
        // This breaks the visual pattern that everything builds around a single table.
        Position initial_cell_pos{-1, 0};
        Cell initial_cell{initial_cell_pos, 0};
        free_cells.push_back(initial_cell);
        cells_by_position.insert({initial_cell_pos, initial_cell});
    }
}

void QueryGraphLayout::ComputeLayout() {
    // Reserve hashmap for peer positions
    Position center{0, 0};
    std::unordered_set<Position, Position::Hasher> peer_positions;
    peer_positions.reserve(30);

    // Iterator over all unplaced entries
    while (auto maybe_unplaced = unplaced_nodes.Pop()) {
        // Get next unplaced node
        auto unplaced = maybe_unplaced.value();
        // XXX
        // if (unplaced->total_peers == 0) {
        //     break;
        // }

        // Get all edge peers of the table using the adjacency map
        auto peers = adjacency[unplaced->node_id];
        peer_positions.clear();
        for (size_t peer : peers) {
            // Lookup their positions via cells_by_position
            auto peer_cell_iter = cells_by_table.find(nodes[peer].table_id);
            if (peer_cell_iter != cells_by_table.end()) {
                // Build a tiny hash set using these positions
                peer_positions.insert(peer_cell_iter->second.position);
            }
        }

        // Track the best cell
        std::optional<double> best_cell_score = std::nullopt;
        std::list<Cell>::iterator best_cell = free_cells.end();

        // Check all free cells
        assert(!free_cells.empty());
        for (auto iter = free_cells.begin(); iter != free_cells.end(); ++iter) {
            // Check if free_pos's neighbor positions are in the hash set
            auto free_pos = iter->position;

            // Count neighbor peers
            uint8_t neighbor_peers = 0;
            neighbor_peers += peer_positions.contains(free_pos.east());
            neighbor_peers += peer_positions.contains(free_pos.west());
            neighbor_peers += peer_positions.contains(free_pos.north_east());
            neighbor_peers += peer_positions.contains(free_pos.north_west());
            neighbor_peers += peer_positions.contains(free_pos.south_east());
            neighbor_peers += peer_positions.contains(free_pos.south_west());

            // Compute a score of the cell, respecting the distance to the cell and the matching peer count
            double cell_score = GetScore(iter->distance_to_center, neighbor_peers);

            // Check if the cell outperforms the best currently found cell
            if (!best_cell_score.has_value() || cell_score > *best_cell_score) {
                best_cell_score = cell_score;
                best_cell = iter;
            }
        }

        // Store the table in the cell
        assert(best_cell_score.has_value());
        assert(best_cell != free_cells.end());
        OccupiedCell chosen_cell{*best_cell, unplaced->node_id, unplaced->total_peers, *best_cell_score};
        free_cells.erase(best_cell);
        cells_by_table.insert({unplaced->table_id, chosen_cell});
        unplaced.node->placed_cell = chosen_cell;

        // For all neighbors, check if they are already present in all_cells
        for (size_t peer : peers) {
            // Lookup their positions via cells_by_position
            auto peer_cell_iter = cells_by_table.find(nodes[peer].table_id);
            if (peer_cell_iter == cells_by_table.end()) {
                continue;
            }
            // For all peers, check if they are pending and increase their placed peer count
            if (auto value = unplaced_nodes.Find(nodes[peer].table_id)) {
                assert(value != nullptr);
                value->node->placed_peers += 1;
                unplaced_nodes.PullUp(value);
            }
        }

        // Helper to add free cell
        auto add_free_cell = [&](Position pos) {
            if (auto iter = cells_by_position.find(pos); iter == cells_by_position.end()) {
                auto dist_to_center = pos.distance_to(center);
                free_cells.emplace_back(pos, dist_to_center);
                cells_by_position.insert({pos, Cell{pos, dist_to_center}});
            }
        };
        add_free_cell(chosen_cell.position.east());
        add_free_cell(chosen_cell.position.west());
        add_free_cell(chosen_cell.position.north_east());
        add_free_cell(chosen_cell.position.north_west());
        add_free_cell(chosen_cell.position.south_east());
        add_free_cell(chosen_cell.position.south_west());
    }

    // XXX
    // Get all unplaced nodes without peers
    // auto remaining_unplaced = unplaced_nodes.Flush();
}

proto::StatusCode QueryGraphLayout::LoadScript(Script& s) {
    script = &s;
    if (!s.analyzed_script) {
        return proto::StatusCode::GRAPH_INPUT_NOT_ANALYZED;
    }
    PrepareLayout(*s.analyzed_script);
    ComputeLayout();
    return proto::StatusCode::OK;
}

flatbuffers::Offset<proto::QueryGraphLayout> QueryGraphLayout::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::QueryGraphLayoutT layout;
    layout.table_nodes.resize(nodes.size());
    layout.edges.resize(edges.size());
    layout.edge_nodes.resize(edge_nodes.size());

    auto center_x = 0;
    auto center_y = 0;
    for (uint32_t i = 0; i < nodes.size(); ++i) {
        auto cell = nodes[i].placed_cell;
        assert(!cell.has_value());
        auto& placed_cell = *cell;
        auto x = center_x + placed_cell.position.column * config.cell_width;
        auto y = center_y + placed_cell.position.row * config.cell_height;
        bool is_referenced = !nodes[i].table_reference_id.IsNull();
        auto proto_node = std::make_unique<proto::QueryGraphLayoutTableNodeT>();
        proto_node->table_id = nodes[i].table_id.Pack();
        proto_node->table_name = nodes[i].table_name.table_name;
        proto_node->height = config.table_height;
        proto_node->width = config.table_width;
        proto_node->is_referenced = is_referenced;
        proto_node->position =
            std::make_unique<proto::QueryGraphLayoutVertex>(x - config.cell_width / 2, y - config.cell_height / 2);
        layout.table_nodes[i] = std::move(proto_node);
    }
    size_t edge_node_reader = 0;
    size_t edge_node_writer = 0;
    for (uint32_t i = 0; i < edges.size(); ++i) {
        auto& edge = edges[i];
        uint32_t nodes_begin = edge_node_writer;
        for (size_t j = 0; j < edge.node_count_left; ++j) {
            auto& edge_node = edge_nodes[edge_node_reader++];
            layout.edge_nodes[edge_node_writer] = proto::QueryGraphLayoutEdgeNode{
                edge_node.table_id.Pack(),
                edge_node.column_reference_id.Pack(),
                edge_node.ast_node_id.Pack(),
                edge_node.node_id.value_or(-1),
            };
            edge_node_writer += edge_node.node_id.has_value();
        }
        uint16_t node_count_left = edge_node_writer - nodes_begin;
        for (size_t j = 0; j < edge.node_count_right; ++j) {
            auto& edge_node = edge_nodes[edge_node_reader++];
            layout.edge_nodes[edge_node_writer] = proto::QueryGraphLayoutEdgeNode{
                edge_node.table_id.Pack(),
                edge_node.column_reference_id.Pack(),
                edge_node.ast_node_id.Pack(),
                edge_node.node_id.value_or(-1),
            };
            edge_node_writer += edge_node.node_id.has_value();
        }
        uint16_t node_count_right = edge_node_writer - (nodes_begin + node_count_left);
        proto::QueryGraphLayoutEdge proto_edge{
            edge.edge_id.Pack(), edge.ast_node_id.Pack(), nodes_begin,
            node_count_left,     node_count_right,        edge.expression_operator,
        };
        layout.edges[i] = proto_edge;
    }
    layout.edge_nodes.erase(layout.edge_nodes.begin() + edge_node_writer, layout.edge_nodes.end());

    return proto::QueryGraphLayout::Pack(builder, &layout);
}

}  // namespace sqlynx
