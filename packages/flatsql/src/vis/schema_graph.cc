#include "flatsql/vis/schema_graph.h"

#include <cmath>

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
double euclideanDistance(SchemaGraph::Vector v) { return sqrt(v.dx * v.dx + v.dy * v.dy); }
/// Get the unit vector
SchemaGraph::Vector unitVector(SchemaGraph::Vector v) { return v / euclideanDistance(v); }

}  // namespace

void SchemaGraph::update() {
    Vector zero;
    std::fill(displacement.begin(), displacement.end(), zero);

    double edge_force_squared = edge_force * edge_force;

    for (size_t i = 0; i < nodes.size(); ++i) {
        // Attraction force to center
        Vector center_delta = nodes[i] - gravity.position;
        double center_distance = euclideanDistance(center_delta);
        if (center_distance != 0) {
            double attraction = center_distance * center_distance / gravity.force;
            displacement[i] = displacement[i] + (center_delta / center_distance * attraction);
        }

        // Repulsion force to repulsion points
        for (auto& v : extra_repulsion) {
            Vector delta = nodes[i] - v.position;
            double distance = euclideanDistance(delta);
            if (distance == 0) continue;
            double repulsion = (v.force * v.force) / distance;
            displacement[i] = displacement[i] + (delta / distance * repulsion);
        }

        // Repulsion force between vertex pairs
        for (size_t j = 0; j < nodes.size(); ++j) {
            Vector delta = nodes[i] - nodes[j];
            double distance = euclideanDistance(delta);
            if (distance == 0) continue;
            double repulsion = edge_force_squared / distance;
            displacement[i] = displacement[i] + (delta / distance * repulsion);
            displacement[j] = displacement[j] - (delta / distance * repulsion);
        }

        // Attraction force between edges
        for (size_t j : adjacency[i]) {
            Vector delta = nodes[i] - nodes[j];
            double distance = euclideanDistance(delta);
            if (distance == 0) continue;
            double attraction = distance * distance / edge_force_squared;
            displacement[i] = displacement[i] + (delta / distance * attraction);
            displacement[j] = displacement[j] - (delta / distance * attraction);
        }
    }
}

void SchemaGraph::Configure(double width, double height, double gravity_x, double gravity_y, double gravity_force,
                            double edge_force) {
    canvas_width = width;
    canvas_height = height;
    gravity = {.position = {gravity_x, gravity_y}, .force = gravity_force};
    this->edge_force = edge_force;
    extra_repulsion.clear();
}

void SchemaGraph::AddRepulsion(double x, double y, double force) {
    extra_repulsion.push_back({.position = {x, y}, .force = force});
}

void SchemaGraph::LoadScript(flatsql::Script& script) {
    // XXX
}

flatbuffers::Offset<proto::schemagraph::SchemaGraph> SchemaGraph::Pack(flatbuffers::FlatBufferBuilder& builder) {
    // XXX
    return {};
}

}  // namespace flatsql
