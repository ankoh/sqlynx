#include "flatsql/vis/schema_grid.h"

namespace flatsql {

namespace {

constexpr size_t NULL_TABLE_ID = std::numeric_limits<uint32_t>::max();
/// Get the score
uint32_t GetScore(double distance, uint8_t neighbor_peers) { return distance; }

}  // namespace

void SchemaGrid::PrepareLayout() {
    // Internal and external tables
    size_t table_count = script->tables.size();
    if (script->external_script) {
        table_count += script->external_script->tables.size();
    }
    // Load adjacency map
    assert(nodes.empty());
    nodes.reserve(table_count);
    // Load internal tables
    for (uint32_t i = 0; i < script->tables.size(); ++i) {
        size_t node_id = nodes.size();
        QualifiedID table_id{script->context_id, i};
        nodes.emplace_back(node_id, table_id, 0);
    }
    // Add external tables
    if (script->external_script) {
        for (uint32_t i = 0; i < script->external_script->tables.size(); ++i) {
            size_t node_id = nodes.size();
            QualifiedID table_id{script->external_script->context_id, i};
            nodes.emplace_back(node_id, table_id, 0);
        }
    }
    // Helper to create a node id
    auto create_node_id = [](QualifiedID id, AnalyzedScript& script) {
        return id.GetIndex() + (id.GetContext() == script.context_id ? 0 : script.tables.size());
    };
    // Add edge node ids
    assert(edge_nodes.empty());
    edge_nodes.resize(script->graph_edge_nodes.size());
    for (size_t i = 0; i < script->graph_edge_nodes.size(); ++i) {
        AnalyzedScript::QueryGraphEdgeNode& node = script->graph_edge_nodes[i];
        QualifiedID column_reference_id{script->context_id, node.column_reference_id};
        auto& col_ref = script->column_references[node.column_reference_id];
        QualifiedID ast_node_id =
            col_ref.ast_node_id.has_value() ? QualifiedID{script->context_id, *col_ref.ast_node_id} : QualifiedID{};
        QualifiedID table_id = script->column_references[node.column_reference_id].table_id;
        uint32_t node_id = table_id.IsNull() ? NULL_TABLE_ID : create_node_id(table_id, *script);
        edge_nodes[i] = EdgeNode{column_reference_id, ast_node_id, table_id, node_id};
    }
    // Add edges
    assert(edges.empty());
    edges.resize(script->graph_edges.size());
    for (uint32_t i = 0; i < script->graph_edges.size(); ++i) {
        AnalyzedScript::QueryGraphEdge& edge = script->graph_edges[i];
        edges[i] = {QualifiedID{script->context_id, i},
                    edge.ast_node_id.has_value() ? QualifiedID{script->context_id, *edge.ast_node_id} : QualifiedID{},
                    edge.nodes_begin,
                    edge.node_count_left,
                    edge.node_count_right,
                    edge.expression_operator};
    }
    // Collect nˆ2 adjacency pairs for now.
    // We might want to model hyper-edges differently for edge attraction in the future
    std::vector<std::pair<size_t, size_t>> adjacency_pairs;
    for (size_t i = 0; i < script->graph_edges.size(); ++i) {
        AnalyzedScript::QueryGraphEdge& edge = script->graph_edges[i];
        // Emit nˆ2 adjacency pairs with patched node ids
        for (size_t l = 0; l < edge.node_count_left; ++l) {
            size_t lcol = script->graph_edge_nodes[edge.nodes_begin + l].column_reference_id;
            QualifiedID ltid = script->column_references[lcol].table_id;
            if (ltid.IsNull()) continue;
            auto ln = create_node_id(ltid, *script);
            // Emit pair for each right node
            for (size_t r = 0; r < edge.node_count_right; ++r) {
                size_t rcol = script->graph_edge_nodes[edge.nodes_begin + edge.node_count_left + r].column_reference_id;
                QualifiedID rtid = script->column_references[rcol].table_id;
                if (rtid.IsNull()) continue;
                auto rn = create_node_id(rtid, *script);
                adjacency_pairs.emplace_back(ln, rn);
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
}

void SchemaGrid::ComputeLayout() {
    // Reserve hashmap for peer positions
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
        uint32_t best_cell_score = 0;
        Cell best_cell;

        // Check all free cells
        assert(!free_cells.empty());
        for (auto free_cell : free_cells) {
            // Check if free_pos's neighbor positions are in the hash set
            auto free_pos = free_cell.position;

            // Count neighbor peers
            uint8_t neighbor_peers = 0;
            neighbor_peers += peer_positions.contains(free_pos.east());
            neighbor_peers += peer_positions.contains(free_pos.west());
            neighbor_peers += peer_positions.contains(free_pos.north_east());
            neighbor_peers += peer_positions.contains(free_pos.north_west());
            neighbor_peers += peer_positions.contains(free_pos.south_east());
            neighbor_peers += peer_positions.contains(free_pos.south_west());

            // Compute a score of the cell, respecting the distance to the cell and the matching peer count
            auto cell_score = GetScore(free_cell.distance_to_center, neighbor_peers);

            // Check if the cell outperforms the best currently found cell
            if (cell_score > best_cell_score) {
                best_cell_score = cell_score;
                best_cell = free_cell;
            }
        }

        // Store the table in the cell
        cells_by_table.insert({unplaced->table_id, best_cell});

        // For all neighbors, check if they are already present in all_cells
        for (size_t peer : peers) {
            // Lookup their positions via cells_by_position
            auto peer_cell_iter = cells_by_table.find(nodes[peer].table_id);
            if (peer_cell_iter != cells_by_table.end()) {
                continue;
            }
            // For all peers, check if they are pending and increase their placed peer count
            if (auto value = unplaced_nodes.Find(nodes[peer].table_id)) {
                value->node->placed_peers += 1;
                unplaced_nodes.PullUp(value);
            }
        }

        // Helper to add free cell
        auto add_free_cell = [&](Position pos) {
            if (auto iter = cells_by_position.find(pos); iter != cells_by_position.end()) {
                free_cells.emplace_back(pos, pos.distance_to(grid_center));
            }
        };
        add_free_cell(best_cell.position.east());
        add_free_cell(best_cell.position.west());
        add_free_cell(best_cell.position.north_east());
        add_free_cell(best_cell.position.north_west());
        add_free_cell(best_cell.position.south_east());
        add_free_cell(best_cell.position.south_west());
    }

    // XXX
    // Get all unplaced nodes without peers
    // auto remaining_unplaced = unplaced_nodes.Flush();
}

}  // namespace flatsql
