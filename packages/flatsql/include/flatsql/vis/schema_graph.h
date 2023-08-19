#pragma once

#include <vector>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/context.h"
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
        QualifiedID edge_id;
        QualifiedID ast_node_id;
        uint32_t nodes_begin = 0;
        uint16_t node_count_left = 0;
        uint16_t node_count_right = 0;
        proto::ExpressionOperator expression_operator = proto::ExpressionOperator::DEFAULT;
        Edge(QualifiedID edge_id = {}, QualifiedID ast_node_id = {}, uint32_t nodes_begin = 0,
             uint16_t node_count_left = 0, uint16_t node_count_right = 0,
             proto::ExpressionOperator op = proto::ExpressionOperator::DEFAULT)
            : edge_id(edge_id),
              ast_node_id(ast_node_id),
              nodes_begin(nodes_begin),
              node_count_left(node_count_left),
              node_count_right(node_count_right),
              expression_operator(op) {}
    };
    struct EdgeNode {
        QualifiedID column_reference_id;
        QualifiedID ast_node_id;
        QualifiedID table_id;
        std::optional<uint32_t> node_id;
        EdgeNode(QualifiedID col_ref = {}, QualifiedID ast_node_id = {}, QualifiedID table_id = {},
                 std::optional<uint32_t> node_id = 0)
            : column_reference_id(col_ref), ast_node_id(ast_node_id), table_id(table_id), node_id(node_id) {}
    };
    struct Node {
        QualifiedID table_id;
        Vertex position;
        double width = 0;
        double height = 0;
        Node(QualifiedID table_id, Vertex pos = {0.0, 0.0}, double width = 0, double height = 0.0)
            : table_id(table_id), position(pos), width(width), height(height) {}
    };

    struct Config {
        /// The iterations in the clustering step
        size_t iterations_clustering = 0;
        /// The iterations in the refinement step
        size_t iterations_refinement = 0;
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
        /// The table height
        double table_height = 0;
        /// The table width
        double table_width = 0;
        /// The table margin
        double table_margin = 0;
        /// The grid size
        double grid_size = 0;
    };

   protected:
    /// The analyzed script (if provided)
    std::shared_ptr<AnalyzedScript> script = nullptr;

    /// The adjacency map
    AdjacencyMap adjacency;
    /// The configuration
    Config config;

    /// The edge nodes
    std::vector<EdgeNode> edge_nodes;
    /// The edges
    std::vector<Edge> edges;
    /// The nodes
    std::vector<Node> nodes;
    /// The displacement
    std::vector<Vector> displacement;

   public:
    /// Get the current positions
    auto& GetNodes() { return nodes; }
    /// Get the edge nodes
    auto& GetEdgeNodes() { return edge_nodes; }
    /// Get the edges
    auto& GetEdges() { return edges; }
    /// Configure the schemagraph settings
    void Configure(const Config& config);
    /// Load a script
    void LoadScript(std::shared_ptr<AnalyzedScript> s);
    /// Describe the schema graph
    std::unique_ptr<proto::SchemaGraphDebugInfoT> Describe() const;
    /// Pack the schema graph
    flatbuffers::Offset<proto::SchemaGraphLayout> Pack(flatbuffers::FlatBufferBuilder& builder);
};

}  // namespace flatsql
