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

void repulse_tables(SchemaGraph::TableNode& a, SchemaGraph::TableNode& b, SchemaGraph::Config& config) {
    // Collision: Difference on both axes is less than half of the combined sizes
    auto max_x = (a.width + b.width) / 2;
    auto max_y = (a.height + b.height) / 2;
    auto have_x = abs(a.position.x - b.position.y);
    auto have_y = abs(a.position.x - b.position.y);
    bool collision = (have_x < max_x) & (have_y < max_y);

    if (collision) {
        // Overlap on the right of a?
        auto overlap_right = b.position.x > a.position.x;
        // Overlap on the top of a?
        auto overlap_top = b.position.x > a.position.x;
    } else {
    }
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
        // Attraction force to center
        Vector center_delta = table_nodes[i].position - config.gravity.position;
        double center_distance = euclidean(center_delta);
        if (center_distance != 0) {
            // Gravity becomes weaker the larger the distance, for now we just drop off linearly
            double gravity = gravity_force / center_distance;
            // Move point towards gravitation
            displacement[i] = displacement[i] - (center_delta / center_distance * gravity);
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

        //     // Repulsion force to repulsion points
        //     for (auto& v : extra_repulsion) {
        //         Vector delta = current_positions[i] - v.position;
        //         double distance = euclidean(delta);
        //         if (distance == 0) continue;
        //         double repulsion = (v.force * v.force) / distance;
        //         displacement[i] = displacement[i] + (delta / distance * repulsion);
        //     }
    }

    // Repulsion force between tables
    for (size_t i = 0; i < table_nodes.size(); ++i) {
        for (size_t j = i + 1; j < table_nodes.size(); ++j) {
            // First check if there's an overlap
            auto& node_i = table_nodes[i];
            auto& node_j = table_nodes[j];

            // Collision: Difference on both axes is less than half of the combined sizes
            double max_x = (node_i.width + node_j.width) / 2;
            double max_y = (node_i.height + node_j.height) / 2;
            double have_x = abs(node_i.position.x - node_j.position.x);
            double have_y = abs(node_i.position.y - node_j.position.y);
            double overlap_x = max_x - have_x;
            double overlap_y = max_y - have_y;

            if ((have_x < max_x) & (have_y < max_y)) {
                double fix_x = (node_i.position.x < node_j.position.x) ? overlap_x : -overlap_x;
                displacement[i].dx -= fix_x / 2;
                displacement[j].dx += fix_x / 2;
                double fix_y = (node_i.position.y < node_j.position.y) ? overlap_y : -overlap_y;
                displacement[i].dy -= fix_y / 2;
                displacement[j].dy += fix_y / 2;
            } else {
                // Otherwise we repulse using the center points
                Vector delta = table_nodes[i].position - table_nodes[j].position;
                double distance = euclidean(delta);
                if (distance == 0) continue;
                double repulsion = repulsion_squared / (distance * distance);
                displacement[i] = displacement[i] + (delta * repulsion);
                displacement[j] = displacement[j] - (delta * repulsion);
            }
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

void SchemaGraph::Configure(const Config& config) {
    this->config = config;
    extra_repulsion.clear();
}

void SchemaGraph::AddRepulsion(double x, double y, double force) {
    extra_repulsion.push_back({.position = {x, y}, .force = force});
}

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
        table_nodes.emplace_back(
            Vertex{
                config.gravity.position.x + config.initial_radius * cos(i * angle),
                config.gravity.position.y + config.initial_radius * sin(i * angle),
            },
            config.tableWidth, config.tableMaxHeight);
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
        proto::SchemaGraphVertex pos{table_nodes[i].position.x, table_nodes[i].position.y};
        layout.tables.emplace_back(i, pos, table_nodes[i].width, table_nodes[i].height);
    }

    return proto::SchemaGraphLayout::Pack(builder, &layout);
}

}  // namespace flatsql
