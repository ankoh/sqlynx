#include "flatsql/schema/schema_layout.h"

namespace flatsql {

namespace {

SchemaLayout::Vertex operator+(const SchemaLayout::Vertex& p, const SchemaLayout::Vector& v) {
    return {p.x + v.dx, p.y + v.dy};
}
SchemaLayout::Vertex operator-(const SchemaLayout::Vertex& p, const SchemaLayout::Vector& v) {
    return {p.x - v.dx, p.y - v.dy};
}
SchemaLayout::Vector operator-(const SchemaLayout::Vertex& p1, const SchemaLayout::Vertex& p2) {
    return {p1.x - p2.x, p1.y - p2.y};
}
SchemaLayout::Vector operator+(const SchemaLayout::Vector& p1, const SchemaLayout::Vector& p2) {
    return {p1.dx + p2.dx, p1.dy + p2.dy};
}
SchemaLayout::Vector operator-(const SchemaLayout::Vector& p1, const SchemaLayout::Vector& p2) {
    return {p1.dx - p2.dx, p1.dy - p2.dy};
}
SchemaLayout::Vector operator*(const SchemaLayout::Vector& p, double v) { return {p.dx * v, p.dx * v}; }
SchemaLayout::Vector operator*(double v, const SchemaLayout::Vector& p) { return p * v; }
SchemaLayout::Vector operator/(const SchemaLayout::Vector& p, double v) { return {p.dx / v, p.dx / v}; }

/// The euclidean distance
double euclideanDistance(SchemaLayout::Vector v) { return sqrt(v.dx * v.dx + v.dy * v.dy); }
/// Get the unit vector
SchemaLayout::Vector unitVector(SchemaLayout::Vector v) { return v / euclideanDistance(v); }

}  // namespace

void SchemaLayout::update(double gravitation_force, double edge_force) {
    Vector zero;
    std::fill(displacement.begin(), displacement.end(), zero);

    double edge_force_squared = edge_force * edge_force;

    for (size_t i = 0; i < graph.GetVertexCount(); ++i) {
        // Attraction force to center
        Vector center_delta = positions[i] - center_point;
        double center_distance = euclideanDistance(center_delta);
        if (center_distance != 0) {
            double attraction = center_distance * center_distance / gravitation_force;
            displacement[i] = displacement[i] + (center_delta / center_distance * attraction);
        }

        // Repulsion force to repulsion points
        for (auto& v : repulsion_points) {
            Vector delta = positions[i] - v;
            double distance = euclideanDistance(delta);
            if (distance == 0) continue;
            double repulsion = edge_force_squared / distance;
            displacement[i] = displacement[i] + (delta / distance * repulsion);
        }

        // Repulsion force between vertex pairs
        for (size_t j = 0; j < graph.GetVertexCount(); ++j) {
            Vector delta = positions[i] - positions[j];
            double distance = euclideanDistance(delta);
            if (distance == 0) continue;
            double repulsion = edge_force_squared / distance;
            displacement[i] = displacement[i] + (delta / distance * repulsion);
            displacement[j] = displacement[j] - (delta / distance * repulsion);
        }

        // Attraction force between edges
        for (size_t j : graph[i]) {
            Vector delta = positions[i] - positions[j];
            double distance = euclideanDistance(delta);
            if (distance == 0) continue;
            double attraction = distance * distance / edge_force_squared;
            displacement[i] = displacement[i] + (delta / distance * attraction);
            displacement[j] = displacement[j] - (delta / distance * attraction);
        }
    }
}

}  // namespace flatsql
