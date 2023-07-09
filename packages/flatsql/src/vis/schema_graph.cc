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
SchemaGraph::Vector operator*(const SchemaGraph::Vector& p, double v) { return {p.dx * v, p.dx * v}; }
SchemaGraph::Vector operator*(double v, const SchemaGraph::Vector& p) { return p * v; }
SchemaGraph::Vector operator/(const SchemaGraph::Vector& p, double v) { return {p.dx / v, p.dx / v}; }

/// The euclidean distance
double euclidean(SchemaGraph::Vector v) { return sqrt(v.dx * v.dx + v.dy * v.dy); }
/// Get the unit vector
SchemaGraph::Vector unit_vector(SchemaGraph::Vector v) { return v / euclidean(v); }
/// Place on circle
void place_on_circle(std::span<SchemaGraph::Vertex> positions, double radius, SchemaGraph::Vertex& center) {
    double angle = 2.0 * M_PI / positions.size();
    for (size_t i = 0; i < positions.size(); ++i) {
        positions[i].x = center.x + radius * cos(i * angle);
        positions[i].y = center.y + radius * sin(i * angle);
    }
}
/// Build adjacency map
void load_tables(std::vector<SchemaGraph::Vertex>& positions, AdjacencyMap& adj, AnalyzedScript& script) {
    positions.clear();
    adj.adjacency_nodes.clear();
    adj.adjacency_offsets.clear();
    adj.adjacency_offsets.reserve(script.tables.size() + 1);
    // XXX Load dependencies
    for (size_t i = 0; i < script.tables.size(); ++i) {
        // XXX Store node dimensions
        positions.emplace_back();
        // XXX Store actual table dependencies
        adj.adjacency_offsets.push_back(0);
    }
    adj.adjacency_offsets.push_back(0);
}

}  // namespace

void SchemaGraph::computeStep(double& temperature) {
    // Resize displacement slots?
    if (displacement.size() < current_positions.size()) {
        displacement.resize(current_positions.size());
    }
    // Zero displacements
    Vector zero;
    std::fill(displacement.begin(), displacement.end(), zero);
    double edge_force_squared = edge_force * edge_force;

    // XXX Repulsion should be updated more carefully using a quad tree

    for (size_t i = 0; i < current_positions.size(); ++i) {
        // Attraction force to center
        Vector center_delta = current_positions[i] - gravity.position;
        double center_distance = euclidean(center_delta);
        if (center_distance != 0) {
            double attraction = center_distance * center_distance / gravity.force;
            displacement[i] = displacement[i] + (center_delta / center_distance * attraction);
        }

        // Repulsion force to repulsion points
        for (auto& v : extra_repulsion) {
            Vector delta = current_positions[i] - v.position;
            double distance = euclidean(delta);
            if (distance == 0) continue;
            double repulsion = (v.force * v.force) / distance;
            displacement[i] = displacement[i] + (delta / distance * repulsion);
        }

        // Repulsion force between vertex pairs
        for (size_t j = 0; j < current_positions.size(); ++j) {
            Vector delta = current_positions[i] - current_positions[j];
            double distance = euclidean(delta);
            if (distance == 0) continue;
            double repulsion = edge_force_squared / distance;
            displacement[i] = displacement[i] + (delta / distance * repulsion);
            displacement[j] = displacement[j] - (delta / distance * repulsion);
        }

        // Attraction force between edges
        for (size_t j : adjacency[i]) {
            Vector delta = current_positions[i] - current_positions[j];
            double distance = euclidean(delta);
            if (distance == 0) continue;
            double attraction = distance * distance / edge_force_squared;
            displacement[i] = displacement[i] + (delta / distance * attraction);
            displacement[j] = displacement[j] - (delta / distance * attraction);
        }
    }

    // Update all nodes
    for (size_t i = 0; i < current_positions.size(); ++i) {
        // Skip if difference is too small
        double normed = euclidean(displacement[i]);
        if (normed < 1.0) {
            continue;
        }
        // Cap the displacement by temperature
        double capped_length = std::min(normed, temperature);
        displacement[i] = displacement[i] / normed * capped_length;
        // Update the nodes
        current_positions[i] = current_positions[i] + displacement[i];
    }

    // Cooldown temperature
    if (temperature > cooldown_until) {
        temperature *= cooldown_factor;
    } else {
        temperature = cooldown_until;
    }
}

void SchemaGraph::Configure(size_t iteration_count, double cooldown_factor, double cooldown_until, double board_width,
                            double board_height, double edge_force, double gravity_x, double gravity_y,
                            double gravity_force) {
    this->iteration_count = iteration_count;
    this->cooldown_factor = cooldown_factor;
    this->cooldown_until = cooldown_until;
    this->board_width = board_width;
    this->board_height = board_height;
    gravity = {.position = {gravity_x, gravity_y}, .force = gravity_force};
    this->edge_force = edge_force;
    extra_repulsion.clear();
}

void SchemaGraph::AddRepulsion(double x, double y, double force) {
    extra_repulsion.push_back({.position = {x, y}, .force = force});
}

void SchemaGraph::LoadScript(std::shared_ptr<AnalyzedScript> s) {
    script = s;
    // Load adjacency map
    load_tables(current_positions, adjacency, *script);
    // Place all positions on a circle
    place_on_circle(current_positions, 1.0, gravity.position);
    // Compute the initial temperature
    auto temperature = 10 * sqrt(current_positions.size());
    // Compute steps
    for (size_t i = 0; i < iteration_count; ++i) {
        computeStep(temperature);
    }
}

flatbuffers::Offset<proto::SchemaGraphLayout> SchemaGraph::Pack(flatbuffers::FlatBufferBuilder& builder) {
    proto::SchemaGraphLayoutT layout;
    for (size_t i = 0; i < current_positions.size(); ++i) {
        proto::SchemaGraphVertex pos{current_positions[i].x, current_positions[i].y};
        layout.tables.emplace_back(i, pos, 100, 100);
    }
    return proto::SchemaGraphLayout::Pack(builder, &layout);
}

}  // namespace flatsql
