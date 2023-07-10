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
    struct TableNode {
        Vertex position;
        double width = 0;
        double height = 0;
        TableNode(Vertex pos, double width, double height) : position(pos), width(width), height(height) {}
    };

    struct Config {
        /// The iterations
        size_t iteration_count = 0;
        /// The force scaling
        double force_scaling = 0;
        /// The cooldown factor
        double cooldown_factor = 0;
        /// The cooldown until
        double cooldown_until = 0;
        /// The repulsion force
        double repulsion_force = 0;
        /// The edge force
        double edge_attraction_force = 0;
        /// The center gravity point
        VertexWithForce gravity;
        /// The initial radius
        double initial_radius = 0;
        /// The board width
        double board_width = 0;
        /// The board height
        double board_height = 0;
        /// The table width
        double table_width = 0;
        /// The table constant height
        double table_constant_height = 0;
        /// The table column height
        double table_column_height = 0;
        /// The table max height
        double table_max_height = 0;
        /// The table margin
        double table_margin = 0;
    };

   protected:
    /// The analyzed script (if provided)
    std::shared_ptr<AnalyzedScript> script = nullptr;

    /// The adjacency map
    AdjacencyMap adjacency;
    /// The configuration
    Config config;

    /// The table nodes
    std::vector<TableNode> table_nodes;
    /// The displacement
    std::vector<Vector> displacement;

    /// Execute a step
    void computeStep(size_t iteration, double& temperature);

   public:
    /// Get the current positions
    auto& GetNodes() { return table_nodes; }
    /// Configure the schemagraph settings
    void Configure(const Config& config);
    /// Load a script
    void LoadScript(std::shared_ptr<AnalyzedScript> s);
    /// Pack the schema graph
    flatbuffers::Offset<proto::SchemaGraphLayout> Pack(flatbuffers::FlatBufferBuilder& builder);
};

}  // namespace flatsql
