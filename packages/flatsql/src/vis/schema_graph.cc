#include "flatsql/vis/schema_graph.h"

#include <algorithm>
#include <cmath>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/vis/adjacency_map.h"

namespace flatsql {

namespace {

SchemaGraph::Vertex operator+(const SchemaGraph::Vertex& p, const SchemaGraph::Vector& v) {
    return {p.x + v.dx, p.y + v.dy};
}
SchemaGraph::Vertex operator-(const SchemaGraph::Vertex& p, const SchemaGraph::Vector& v) {
    return {p.x - v.dx, p.y - v.dy};
}
SchemaGraph::Vector operator-(const SchemaGraph::Vertex& p1, const SchemaGraph::Vertex& p2) {
    return {p1.x - p2.x, p1.y - p2.y};
}
SchemaGraph::Vector operator+(const SchemaGraph::Vector& p1, const SchemaGraph::Vector& p2) {
    return {p1.dx + p2.dx, p1.dy + p2.dy};
}
SchemaGraph::Vector operator-(const SchemaGraph::Vector& p1, const SchemaGraph::Vector& p2) {
    return {p1.dx - p2.dx, p1.dy - p2.dy};
}
SchemaGraph::Vector operator*(const SchemaGraph::Vector& p, double v) { return {p.dx * v, p.dy * v}; }
SchemaGraph::Vector operator*(double v, const SchemaGraph::Vector& p) { return p * v; }
SchemaGraph::Vector operator/(const SchemaGraph::Vector& p, double v) { return {p.dx / v, p.dy / v}; }

/// The euclidean distance
double euclidean(SchemaGraph::Vector v) { return sqrt(v.dx * v.dx + v.dy * v.dy); }
/// Get the unit vector
SchemaGraph::Vector unit_vector(SchemaGraph::Vector v) { return v / euclidean(v); }

#define INORDER(F) F(0), F(12), F(24), F(36), F(48), F(60), F(72), F(84),
#define REVERSE(F) F(0), F(-12), F(-24), F(-36), F(-48), F(-60), F(-72), F(-84),
std::array<double, 16> JIGGLE_SIN{
#define F(V) std::sin(V * 180 / M_PI)
    INORDER(F) REVERSE(F)
#undef F
};
std::array<double, 16> JIGGLE_COS{
#define F(V) std::cos(V * 180 / M_PI)
    INORDER(F) REVERSE(F)
#undef F
};

SchemaGraph::Vector jiggle(size_t table_id, size_t iteration, SchemaGraph::Vector vec) {
    size_t ofs = (table_id & 0b1) * 8;
    double sin = JIGGLE_SIN[(ofs + iteration) & 15];
    double cos = JIGGLE_COS[(ofs + iteration) & 15];
    double x = vec.dx * cos - vec.dy * sin;
    double y = vec.dx * sin + vec.dy * cos;
    return {x, y};
}

}  // namespace

void SchemaGraph::computeStep(size_t iteration, double& temperature) {
    // Resize displacement slots?
    if (displacement.size() < nodes.size()) {
        displacement.resize(nodes.size());
    }
    // Zero displacements
    Vector zero;
    std::fill(displacement.begin(), displacement.end(), zero);

    std::array<Vertex, 3> gravity{
        Vertex{1 * config.board_width / 4, config.board_height / 2},
        Vertex{2 * config.board_width / 4, config.board_height / 2},
        Vertex{3 * config.board_width / 4, config.board_height / 2},
    };

    double repulsion_scaled = config.repulsion_force * config.force_scaling;
    double repulsion_squared = repulsion_scaled;
    double edge_attraction_scaled = config.edge_attraction_force * config.force_scaling;
    double edge_attraction_squared = edge_attraction_scaled * config.edge_attraction_force;
    double gravity_scaled = config.gravity_force * config.force_scaling;
    double gravity_squared = gravity_scaled * gravity_scaled;

    // XXX Repulsion should be updated more carefully using a quad tree

    constexpr double MIN_DISTANCE = 0.5;

    for (size_t i = 0; i < nodes.size(); ++i) {
        auto& table_node = nodes[i];

        // Gravity attraction
        for (auto& center : gravity) {
            Vector delta = center - table_node.position;
            double distance = std::max(euclidean(delta), MIN_DISTANCE);
            Vector normal = delta / distance;
            double attraction = gravity_squared / (distance * distance);
            displacement[i] = displacement[i] + normal * attraction;
        }

        //     // Attraction force between edges
        //     for (size_t j : adjacency[i]) {
        //         Vector delta = current_positions[i] - current_positions[j];
        //         double distance = euclidean(delta);
        //         if (distance == 0) continue;
        //         double attraction = distance * distance / edge_attraction_squared;
        //         displacement[i] = displacement[i] + (delta / distance * attraction);
        //         displacement[j] = displacement[j] - (delta / distance * attraction);
        //     }

        // Push back into area
        Vector border_push;
        Vertex north = table_node.position - Vector{0, table_node.height / 2};
        Vertex east = table_node.position + Vector{table_node.width / 2, 0};
        Vertex south = table_node.position + Vector{0, table_node.height / 2};
        Vertex west = table_node.position - Vector{table_node.width / 2, 0};
        border_push.dy += (north.y < 0) ? -north.y : 0;
        border_push.dx -= (east.x > config.board_width) ? (east.x - config.board_width) : 0;
        border_push.dy -= (south.y > config.board_height) ? (south.y - config.board_height) : 0;
        border_push.dx += (west.x < 0) ? -west.x : 0;
        displacement[i] = displacement[i] + repulsion_squared * border_push;
    }

    // Repulsion force between tables
    for (size_t i = 0; i < nodes.size(); ++i) {
        for (size_t j = i + 1; j < nodes.size(); ++j) {
            // Compute distance or overlap vector
            auto& node_i = nodes[i];
            auto& node_j = nodes[j];
            double body_x = (node_i.width + node_j.width) / 2;
            double body_y = (node_i.height + node_j.height) / 2;
            double diff_x = abs(node_i.position.x - node_j.position.x);
            double diff_y = abs(node_i.position.y - node_j.position.y);
            Vector undirected{abs(body_x - diff_x), abs(body_y - diff_y)};
            Vector directed{(node_i.position.x < node_j.position.x) ? undirected.dx : -undirected.dx,
                            (node_i.position.y < node_j.position.y) ? undirected.dy : -undirected.dy};

            double distance = MIN_DISTANCE;
            if ((diff_x < body_x) && (diff_y < body_y)) {
                displacement[i] = displacement[i] - directed / 2;
                displacement[j] = displacement[j] + directed / 2;
            } else {
                directed = jiggle(i, iteration, directed);
                distance = std::max(euclidean(directed), distance);
            }
            double repulsion = repulsion_squared / distance;
            Vector displace_normal = directed / distance;
            displacement[i] = displacement[i] - (displace_normal * repulsion / 2);
            displacement[j] = displacement[j] + (displace_normal * repulsion / 2);
        }
    }

    // Update all nodes
    for (size_t i = 0; i < nodes.size(); ++i) {
        // Skip if difference is too small
        double length = euclidean(displacement[i]);
        if (length < 1.0) {
            continue;
        }
        // Cap the displacement by temperature
        double capped_length = std::min(length, temperature);
        displacement[i] = displacement[i] / length * capped_length;
        // Update the nodes
        nodes[i].position = nodes[i].position + displacement[i];
    }

    // Cooldown temperature
    temperature *= config.cooldown_factor;
}

void SchemaGraph::Configure(const Config& config) { this->config = config; }

void SchemaGraph::LoadScript(std::shared_ptr<AnalyzedScript> s) {
    script = s;
    // Internal and external tables
    size_t table_count = s->tables.size();
    if (s->external_script) {
        table_count += s->external_script->tables.size();
    }
    // Load adjacency map
    nodes.clear();
    nodes.reserve(table_count);
    // Get an initial position
    double angle = 2.0 * M_PI / table_count;
    auto get_pos = [](Config& config, double angle, Analyzer::ID id) {
        double v = angle * id.AsIndex();
        return Vertex{
            config.board_width / 2 + config.initial_radius * cos(v * angle),
            config.board_height / 2 + config.initial_radius * sin(v * angle),
        };
    };
    // Load internal tables
    for (uint32_t i = 0; i < script->tables.size(); ++i) {
        Analyzer::ID id{i, false};
        nodes.emplace_back(id.value, get_pos(config, angle, id), config.table_width + config.table_margin,
                           config.table_max_height + config.table_margin);
    }
    // Add external tables
    if (script->external_script) {
        for (uint32_t i = 0; i < script->external_script->tables.size(); ++i) {
            Analyzer::ID id{i, true};
            nodes.emplace_back(id.value, get_pos(config, angle, id), config.table_width + config.table_margin,
                               config.table_max_height + config.table_margin);
        }
    }
    // Add edge node ids
    edge_nodes.resize(script->graph_edge_nodes.size());
    for (size_t i = 0; i < script->graph_edge_nodes.size(); ++i) {
        proto::QueryGraphEdgeNode& node = script->graph_edge_nodes[i];
        Analyzer::ID table_id = Analyzer::ID(script->column_references[node.column_reference_id()].table_id());
        edge_nodes[i] = table_id.AsIndex() + (table_id.IsExternal() ? 0 : s->tables.size());
    }
    // Collect adjacency pairs
    edges.resize(script->graph_edges.size());
    std::vector<std::pair<size_t, size_t>> adjacency_pairs;
    for (size_t i = 0; i < script->graph_edges.size(); ++i) {
        // Write edge description
        proto::QueryGraphEdge& edge = script->graph_edges[i];
        edges[i] = {edge.nodes_begin(), edge.node_count_left(), edge.node_count_right(), edge.expression_operator()};
        // Emit adjacency pairs with patched node ids
        for (size_t l = 0; l < edge.node_count_left(); ++l) {
            size_t l_col = script->graph_edge_nodes[edge.nodes_begin() + l].column_reference_id();
            Analyzer::ID l_table_id{script->column_references[l_col].table_id()};
            auto l_node_id = l_table_id.AsIndex() + (l_table_id.IsExternal() ? 0 : s->tables.size());
            // Emit pair for each right node
            for (size_t r = 0; r < edge.node_count_right(); ++r) {
                size_t r_col =
                    script->graph_edge_nodes[edge.nodes_begin() + edge.node_count_left() + r].column_reference_id();
                Analyzer::ID r_table_id{script->column_references[r_col].table_id()};
                auto r_node_id = r_table_id.AsIndex() + (r_table_id.IsExternal() ? 0 : s->tables.size());
                adjacency_pairs.emplace_back(l_node_id, r_node_id);
            }
        }
    }
    // Build adjacency map
    adjacency.adjacency_offsets.clear();
    adjacency.adjacency_offsets.reserve(script->graph_edges.size() + 1);
    adjacency.adjacency_nodes.clear();
    adjacency.adjacency_nodes.reserve(adjacency_pairs.size());
    std::sort(adjacency_pairs.begin(), adjacency_pairs.end());
    size_t i = 0;
    for (auto begin = adjacency_pairs.begin(); begin != adjacency_pairs.end();) {
        while (i < begin->first) {
            adjacency.adjacency_offsets.push_back(adjacency.adjacency_nodes.size());
        }
        adjacency.adjacency_offsets.push_back(adjacency.adjacency_nodes.size());
        auto in_partition = [&](auto& adj) { return adj.first == begin->first; };
        auto end = std::partition_point(begin + 1, adjacency_pairs.end(), in_partition);
        for (auto iter = begin; iter != end; ++iter) {
            adjacency.adjacency_nodes.push_back(iter->second);
        }
    }
    adjacency.adjacency_offsets.push_back(adjacency.adjacency_nodes.size());
    adjacency_pairs = {};
    // Compute the initial temperature
    auto temperature = 10 * sqrt(nodes.size());
    // Compute steps
    for (size_t i = 0; i < config.iteration_count; ++i) {
        computeStep(i, temperature);
    }
}

flatbuffers::Offset<proto::SchemaGraphLayout> SchemaGraph::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::SchemaGraphLayoutT layout;
    layout.nodes.resize(nodes.size());
    layout.edges.resize(edges.size());
    layout.edge_nodes.resize(edge_nodes.size());
    for (uint32_t i = 0; i < nodes.size(); ++i) {
        proto::SchemaGraphVertex pos{nodes[i].position.x - nodes[i].width / 2 + config.table_margin / 2,
                                     nodes[i].position.y - nodes[i].height / 2 + config.table_margin / 2};
        proto::SchemaGraphNode proto_node{i, pos, nodes[i].width - config.table_margin,
                                          nodes[i].height - config.table_margin};
        layout.nodes[i] = proto_node;
    }
    for (uint32_t i = 0; i < edges.size(); ++i) {
        auto& edge = edges[i];
        proto::SchemaGraphEdge proto_edge{
            edge.nodes_begin,
            edge.node_count_left,
            edge.node_count_right,
            edge.expression_operator,
        };
        layout.edges[i] = proto_edge;
    }
    for (uint32_t i = 0; i < edge_nodes.size(); ++i) {
        layout.edge_nodes[i] = edge_nodes[i];
    }
    return proto::SchemaGraphLayout::Pack(builder, &layout);
}

}  // namespace flatsql
