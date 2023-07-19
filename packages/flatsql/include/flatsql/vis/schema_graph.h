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
    struct Edge {
        uint32_t nodes_begin = 0;
        uint16_t node_count_left = 0;
        uint16_t node_count_right = 0;
        proto::ExpressionOperator expression_operator = proto::ExpressionOperator::DEFAULT;
        Edge(uint32_t nodes_begin = 0, uint16_t node_count_left = 0, uint16_t node_count_right = 0,
             proto::ExpressionOperator op = proto::ExpressionOperator::DEFAULT)
            : nodes_begin(nodes_begin),
              node_count_left(node_count_left),
              node_count_right(node_count_right),
              expression_operator(op) {}
    };
    struct Node {
        uint32_t table_id = 0;
        Vertex position;
        double width = 0;
        double height = 0;
        Node(size_t table_id = 0, Vertex pos = {0.0, 0.0}, double width = 0, double height = 0.0)
            : table_id(table_id), position(pos), width(width), height(height) {}
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
        /// The edge attraction force
        double edge_attraction_force = 0;
        /// The gravity force
        double gravity_force = 0;
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

    /// The edge nodes
    std::vector<size_t> edge_nodes;
    /// The edges
    std::vector<Edge> edges;
    /// The nodes
    std::vector<Node> nodes;
    /// The displacement
    std::vector<Vector> displacement;

    /// Execute a step
    void computeStep(size_t iteration, double& temperature);

   public:
    /// Get the current positions
    auto& GetNodes() { return nodes; }
    /// Configure the schemagraph settings
    void Configure(const Config& config);
    /// Load a script
    void LoadScript(std::shared_ptr<AnalyzedScript> s);
    /// Pack the schema graph
    flatbuffers::Offset<proto::SchemaGraphLayout> Pack(flatbuffers::FlatBufferBuilder& builder);
};

}  // namespace flatsql
