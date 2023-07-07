#pragma once

#include <cmath>
#include <vector>

#include "flatsql/schema/graph.h"

namespace flatsql {

class SchemaLayout {
   public:
    struct Vertex {
        double x = 0;
        double y = 0;
    };
    struct Vector {
        double dx = 0;
        double dy = 0;
    };

   protected:
    /// The graph
    Graph graph;
    /// The positions
    std::vector<Vertex> positions;
    /// The displacement
    std::vector<Vector> displacement;
    /// The center point
    Vertex center_point;
    /// The repulsion points
    std::vector<Vertex> repulsion_points;

   public:
    /// Update the schema layout
    void update(double gravitation_force, double edge_force);
};

}  // namespace flatsql
