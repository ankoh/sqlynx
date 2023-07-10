#include "flatsql/vis/schema_graph.h"

#include <cmath>

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

#define INORDER(F) F(0), F(5), F(10), F(15), F(20), F(25), F(30), F(35),
#define REVERSE(F) F(0), F(-5), F(-10), F(-15), F(-20), F(-25), F(-30), F(-35),
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
    double sin = JIGGLE_SIN[ofs + iteration & 7];
    double cos = JIGGLE_COS[ofs + iteration & 7];
    double x = vec.dx * cos - vec.dy * sin;
    double y = vec.dx * sin + vec.dy * cos;
    return {x, y};
}

}  // namespace

void SchemaGraph::computeStep(size_t iteration, double& temperature) {
    // Resize displacement slots?
    if (displacement.size() < table_nodes.size()) {
        displacement.resize(table_nodes.size());
    }
    // Zero displacements
    Vector zero;
    std::fill(displacement.begin(), displacement.end(), zero);

    double repulsion_force = config.repulsion_force * config.force_scaling;
    double repulsion_squared = repulsion_force;
    double edge_attraction_force = config.edge_attraction_force * config.force_scaling;
    double edge_attraction_squared = edge_attraction_force * config.edge_attraction_force;
    double gravity_force = config.gravity.force * config.force_scaling;
    double gravity_squared = gravity_force * config.gravity.force;

    // XXX Repulsion should be updated more carefully using a quad tree

    for (size_t i = 0; i < table_nodes.size(); ++i) {
        auto& table_node = table_nodes[i];
        // Gravity force to center
        Vector center_delta = table_node.position - config.gravity.position;
        double center_distance = std::max(euclidean(center_delta), 1.0);

        // Move point towards gravitation with a constant force
        Vector center_normal = center_delta / center_distance;
        displacement[i] = displacement[i] - (center_normal * gravity_force);

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
    for (size_t i = 0; i < table_nodes.size(); ++i) {
        for (size_t j = i + 1; j < table_nodes.size(); ++j) {
            // Compute distance or overlap vector
            auto& node_i = table_nodes[i];
            auto& node_j = table_nodes[j];
            double body_x = (node_i.width + node_j.width) / 2;
            double body_y = (node_i.height + node_j.height) / 2;
            double diff_x = abs(node_i.position.x - node_j.position.x);
            double diff_y = abs(node_i.position.y - node_j.position.y);
            Vector undirected{abs(body_x - diff_x), abs(body_y - diff_y)};
            Vector directed{(node_i.position.x < node_j.position.x) ? undirected.dx : -undirected.dx,
                            (node_i.position.y < node_j.position.y) ? undirected.dy : -undirected.dy};

            double distance = 1.0;
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
    for (size_t i = 0; i < table_nodes.size(); ++i) {
        // Skip if difference is too small
        double length = euclidean(displacement[i]);
        if (length < 1.0) {
            continue;
        }
        // Cap the displacement by temperature
        double capped_length = std::min(length, temperature);
        displacement[i] = displacement[i] / length * capped_length;
        // Update the nodes
        table_nodes[i].position = table_nodes[i].position + displacement[i];
    }

    // Cooldown temperature
    if (temperature > config.cooldown_until) {
        temperature *= config.cooldown_factor;
    } else {
        temperature = config.cooldown_until;
    }
}

void SchemaGraph::Configure(const Config& config) { this->config = config; }

void SchemaGraph::LoadScript(std::shared_ptr<AnalyzedScript> s) {
    script = s;
    // Load adjacency map
    table_nodes.clear();
    adjacency.adjacency_nodes.clear();
    adjacency.adjacency_offsets.clear();
    adjacency.adjacency_offsets.reserve(script->tables.size() + 1);
    // XXX Load dependencies
    double angle = 2.0 * M_PI / script->tables.size();
    for (size_t i = 0; i < script->tables.size(); ++i) {
        // XXX Store node dimensions
        double jiggle = 1 + (static_cast<double>((i & 0b1) == 0) - 0.5);
        table_nodes.emplace_back(
            Vertex{
                config.gravity.position.x + config.initial_radius * cos(i * angle) * jiggle,
                config.gravity.position.y + config.initial_radius * sin(i * angle) * jiggle,
            },
            config.table_width + config.table_margin, config.table_max_height + config.table_margin);
        // XXX Store actual table dependencies
        adjacency.adjacency_offsets.push_back(0);
    }
    adjacency.adjacency_offsets.push_back(0);

    // Compute the initial temperature
    auto temperature = 10 * sqrt(table_nodes.size());
    // Compute steps
    for (size_t i = 0; i < config.iteration_count; ++i) {
        computeStep(i, temperature);
    }
}

flatbuffers::Offset<proto::SchemaGraphLayout> SchemaGraph::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::SchemaGraphLayoutT layout;
    for (size_t i = 0; i < table_nodes.size(); ++i) {
        proto::SchemaGraphVertex pos{table_nodes[i].position.x - table_nodes[i].width / 2 + config.table_margin / 2,
                                     table_nodes[i].position.y - table_nodes[i].height / 2 + config.table_margin / 2};
        layout.tables.emplace_back(i, pos, table_nodes[i].width - config.table_margin,
                                   table_nodes[i].height - config.table_margin);
    }

    return proto::SchemaGraphLayout::Pack(builder, &layout);
}

}  // namespace flatsql
