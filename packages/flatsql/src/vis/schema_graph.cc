#include "flatsql/vis/schema_graph.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/api.h"
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

using Config = SchemaGraph::Config;
using Node = SchemaGraph::Node;
using Vector = SchemaGraph::Vector;
using Vertex = SchemaGraph::Vertex;

template <bool nodesAsBoxes>
void step(const Config& config, const AdjacencyMap& adjacency, std::vector<Node>& nodes,
          std::vector<Vector>& displacement, double& temperature, size_t iteration) {
    // Resize displacement slots?
    if (displacement.size() < nodes.size()) {
        displacement.resize(nodes.size());
    }
    // Zero displacements
    Vector zero;
    std::fill(displacement.begin(), displacement.end(), zero);

    // The gravity points
    std::array<Vertex, 1> gravity{
        Vertex{config.board_width / 2, config.board_height / 2},
    };

    double repulsion_scaled = config.repulsion_force * config.force_scaling;
    double repulsion_squared = repulsion_scaled;
    double edge_attraction_scaled = config.edge_attraction_force * config.force_scaling;
    double edge_attraction_squared = edge_attraction_scaled * edge_attraction_scaled;
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
            double attraction = gravity_scaled / distance;
            Vector normal = delta / distance;
            displacement[i] = displacement[i] + normal * attraction;
        }

        // Attraction force between edges
        for (size_t j : adjacency[i]) {
            Vector delta = table_node.position - nodes[j].position;
            double distance = std::max(euclidean(delta), MIN_DISTANCE);
            double attraction = edge_attraction_scaled * sqrt(distance);
            Vector normal = delta / distance;
            displacement[i] = displacement[i] - normal * attraction / 2;
            displacement[j] = displacement[j] + normal * attraction / 2;
        }

        // Push back into area
        if constexpr (nodesAsBoxes) {
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
        } else {
            auto pos = table_node.position;
            Vector border_push;
            border_push.dy += (pos.y < 0) ? -pos.y : 0;
            border_push.dx -= (pos.x > config.board_width) ? (pos.x - config.board_width) : 0;
            border_push.dy -= (pos.y > config.board_height) ? (pos.y - config.board_height) : 0;
            border_push.dx += (pos.x < 0) ? -pos.x : 0;
            displacement[i] = displacement[i] + repulsion_squared * border_push;
        }
    }

    // Repulsion force between tables
    for (size_t i = 0; i < nodes.size(); ++i) {
        for (size_t j = i + 1; j < nodes.size(); ++j) {
            if constexpr (nodesAsBoxes) {
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
            } else {
                // Nodes are dots
                auto& node_i = nodes[i];
                auto& node_j = nodes[j];
                auto diff = node_i.position - node_j.position;
                double distance = std::max(euclidean(diff), distance);
                double repulsion = repulsion_squared / distance;
                Vector displace_normal = diff / distance;
                displace_normal = jiggle(i, iteration, displace_normal);
                displacement[i] = displacement[i] - (displace_normal * repulsion / 2);
                displacement[j] = displacement[j] + (displace_normal * repulsion / 2);
            }
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

constexpr size_t NULL_TABLE_ID = std::numeric_limits<uint32_t>::max();

}  // namespace

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
        edge_nodes[i] =
            table_id.IsNull() ? NULL_TABLE_ID : (table_id.AsIndex() + (table_id.IsExternal() ? 0 : s->tables.size()));
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
            Analyzer::ID l_table{script->column_references[l_col].table_id()};
            if (l_table.IsNull()) continue;
            auto l_node = l_table.AsIndex() + (l_table.IsExternal() ? 0 : s->tables.size());
            // Emit pair for each right node
            for (size_t r = 0; r < edge.node_count_right(); ++r) {
                size_t r_col =
                    script->graph_edge_nodes[edge.nodes_begin() + edge.node_count_left() + r].column_reference_id();
                Analyzer::ID r_table{script->column_references[r_col].table_id()};
                if (r_table.IsNull()) continue;
                auto r_node = r_table.AsIndex() + (r_table.IsExternal() ? 0 : s->tables.size());
                adjacency_pairs.emplace_back(l_node, r_node);
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
        for (; i < begin->first; ++i) {
            adjacency.adjacency_offsets.push_back(adjacency.adjacency_nodes.size());
        }
        adjacency.adjacency_offsets.push_back(adjacency.adjacency_nodes.size());
        auto in_partition = [&](auto& adj) { return adj.first == begin->first; };
        auto end = std::partition_point(begin + 1, adjacency_pairs.end(), in_partition);
        for (auto iter = begin; iter != end; ++iter) {
            adjacency.adjacency_nodes.push_back(iter->second);
        }
        begin = end;
    }
    adjacency.adjacency_offsets.push_back(adjacency.adjacency_nodes.size());
    adjacency_pairs = {};
    // First, cluster nodes without boxes
    auto temperature = 10 * sqrt(nodes.size());
    for (size_t i = 0; i < config.iterations_clustering; ++i) {
        step<false>(config, adjacency, nodes, displacement, temperature, i);
    }
    // Refine node positions using boxes
    temperature = 10 * sqrt(nodes.size());
    for (size_t i = 0; i < config.iterations_refinement; ++i) {
        step<true>(config, adjacency, nodes, displacement, temperature, i);
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
        proto::SchemaGraphNode proto_node{nodes[i].table_id, pos, nodes[i].width - config.table_margin,
                                          nodes[i].height - config.table_margin};
        layout.nodes[i] = proto_node;
    }
    size_t edge_node_reader = 0;
    size_t edge_node_writer = 0;
    for (uint32_t i = 0; i < edges.size(); ++i) {
        auto& edge = edges[i];
        uint32_t nodes_begin = edge_node_writer;
        for (size_t j = 0; j < edge.node_count_left; ++j) {
            uint32_t table_id = edge_nodes[edge_node_reader++];
            layout.edge_nodes[edge_node_writer] = table_id;
            edge_node_writer += table_id != NULL_TABLE_ID;
        }
        uint16_t node_count_left = edge_node_writer - nodes_begin;
        for (size_t j = 0; j < edge.node_count_right; ++j) {
            uint32_t table_id = edge_nodes[edge_node_reader++];
            layout.edge_nodes[edge_node_writer] = table_id;
            edge_node_writer += table_id != NULL_TABLE_ID;
        }
        uint16_t node_count_right = edge_node_writer - (nodes_begin + node_count_left);
        proto::SchemaGraphEdge proto_edge{
            nodes_begin,
            node_count_left,
            node_count_right,
            edge.expression_operator,
        };
        layout.edges[i] = proto_edge;
    }
    layout.edge_nodes.erase(layout.edge_nodes.begin() + edge_node_writer, layout.edge_nodes.end());

    return proto::SchemaGraphLayout::Pack(builder, &layout);
}

}  // namespace flatsql
