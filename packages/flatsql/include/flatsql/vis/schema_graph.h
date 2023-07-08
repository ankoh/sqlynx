#pragma once

#include <vector>

#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/vis/adjacency_map.h"
#include "flatsql/vis/schema_graph.h"

namespace flatsql {

class SchemaGraph {
   public:
    struct Vertex {
        double x = 0;
        double y = 0;
    };
    struct Vector {
        double dx = 0;
        double dy = 0;
    };
    struct VertexWithForce {
        Vertex position;
        double force = 0;
    };

   protected:
    /// The analyzed script (if provided)
    std::shared_ptr<AnalyzedScript> script = nullptr;

    /// The center gravity point
    VertexWithForce gravity;
    /// The canvas width
    double canvas_width = 0;
    /// The canvas height
    double canvas_height = 0;
    /// The edge force
    double edge_force = 0;
    /// Extra repulsion
    std::vector<VertexWithForce> extra_repulsion;

    /// The adjacency map
    AdjacencyMap adjacency;
    /// The nodes
    std::vector<Vertex> nodes;
    /// The displacement
    std::vector<Vector> displacement;

    /// Update the schema layout
    void update();

   public:
    /// Constructor
    SchemaGraph() = default;

    /// Configure the schemagraph settings
    void Configure(double width, double height, double gravity_x, double gravity_y, double gravity_force,
                   double edge_force);
    /// Add a repulsion point
    void AddRepulsion(double x, double y, double force);
    /// Load a script
    void LoadScript(flatsql::Script& script);
    /// Pack the schema graph
    flatbuffers::Offset<proto::SchemaGraphLayout> Pack(flatbuffers::FlatBufferBuilder& builder);
};

}  // namespace flatsql
