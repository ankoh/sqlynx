#pragma once

#include <cassert>
#include <queue>
#include <span>
#include <unordered_set>
#include <vector>

#include "flatsql/context.h"
#include "flatsql/script.h"
#include "flatsql/utils/binary_heap.h"
#include "flatsql/utils/chunk_buffer.h"
#include "flatsql/vis/adjacency_map.h"

namespace flatsql {

class SchemaGrid {
   public:
    /// The coordinates
    struct Position {
        /// The grid column
        int32_t column;
        /// The grid row
        int32_t row;
        /// Constructor
        Position(int32_t x, int32_t y) : column(x), row(y) {}

        /// Get neighbor north-west
        Position north_west() const { return {column + 1, row - 1}; }
        /// Get neighbor north-east
        Position north_east() const { return {column - 1, row - 1}; }
        /// Get neighbor south-east
        Position south_east() const { return {column - 1, row + 1}; }
        /// Get neighbor south-west
        Position south_west() const { return {column + 1, row + 1}; }
        /// Get neighbor west
        Position west() const { return {column + 2, row}; }
        /// Get neighbor east
        Position east() const { return {column - 2, row}; }
        // Get distance to a point
        double distance_to(Position pos) {
            return std::sqrt(std::pow(static_cast<double>(column) - static_cast<double>(pos.column), 2) +
                             std::pow(static_cast<double>(row) - static_cast<double>(pos.row), 2));
        }
        /// Equality comparison
        bool operator==(const Position& other) const { return column == other.column && row == other.row; }
        /// A hasher
        struct Hasher {
            size_t operator()(const Position& pos) const {
                size_t hash = 0;
                hash_combine(hash, pos.column);
                hash_combine(hash, pos.row);
                return hash;
            }
        };
    };
    /// A config
    struct Config {
        /// The table height
        double table_height = 0;
        /// The table width
        double table_width = 0;
        /// The grid cell width
        double grid_cell_width = 0;
        /// The grid cell width
        double grid_cell_height = 0;
    };
    /// A node
    struct Node;
    /// A grid cell
    struct Cell {
        /// The position
        Position position;
        /// The distance to the center
        double distance_to_center;
        /// Constructor
        Cell(Position pos = Position{0, 0}, double dist = 0.0, Node* node = nullptr)
            : position(pos), distance_to_center(dist) {}
    };
    /// A node that is placed on the grid
    struct Node {
        /// The node id
        size_t node_id;
        /// The table id
        QualifiedID table_id;
        /// The total number of peers
        uint32_t total_peers;
        /// The number of peers that are already placed
        uint32_t placed_peers;
        /// The placed cell
        std::optional<Cell> placed_cell;
        /// Constructor
        Node(size_t node_id, QualifiedID table_id, uint32_t total_peers)
            : node_id(node_id), table_id(table_id), total_peers(total_peers) {}

        /// A ptr to a node
        struct Ref {
            Node* node;
            /// Constructor
            Ref(Node& n) : node(&n) {}
            /// Get the heap key
            QualifiedID GetKey() const { return node->table_id; }

            Node& operator*() const { return *node; }
            Node* operator->() const { return node; }
            /// The comparison operator
            bool operator<(const Ref& other) const {
                return node->placed_peers < other.node->placed_peers ||
                       (node->placed_peers <= other.node->placed_peers && node->total_peers < other.node->total_peers);
            }
        };
    };
    /// An edge
    struct Edge {
        /// The edge id
        QualifiedID edge_id;
        /// The AST node id
        QualifiedID ast_node_id;
        /// The begin of the nodes
        uint32_t nodes_begin = 0;
        /// The source node count
        uint16_t node_count_left = 0;
        /// The target node count
        uint16_t node_count_right = 0;
        /// The expression operator
        proto::ExpressionOperator expression_operator = proto::ExpressionOperator::DEFAULT;
        /// Constructor
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
    /// An edge node
    struct EdgeNode {
        /// The column reference id
        QualifiedID column_reference_id;
        /// The AST node id
        QualifiedID ast_node_id;
        /// The table id
        QualifiedID table_id;
        /// The node id
        std::optional<uint32_t> node_id;
        /// Constructor
        EdgeNode(QualifiedID col_ref = {}, QualifiedID ast_node_id = {}, QualifiedID table_id = {},
                 std::optional<uint32_t> node_id = std::nullopt)
            : column_reference_id(col_ref), ast_node_id(ast_node_id), table_id(table_id), node_id(node_id) {}
    };

    /// The analyzed script (if provided)
    std::shared_ptr<AnalyzedScript> script = nullptr;
    /// The configuration
    Config config;
    /// The adjacency map
    AdjacencyMap adjacency;

    /// The edge nodes
    std::vector<EdgeNode> edge_nodes;
    /// The edges
    std::vector<Edge> edges;
    /// The nodes
    std::vector<Node> nodes;

    /// The grid cells by position
    std::unordered_map<Position, Cell, Position::Hasher> cells_by_position;
    /// The grid cells by table
    std::unordered_map<QualifiedID, Cell, QualifiedID::Hasher> cells_by_table;
    /// The free cells
    std::vector<Cell> free_cells;
    /// The unplaced nodes, sorted by [placed_peers, total_peers]
    IndexedBinaryHeap<Node::Ref, QualifiedID, QualifiedID::Hasher, BinaryHeapType::MaxHeap> unplaced_nodes;

    /// Reset the grid
    void Clear();
    /// Prepare layouting and create unplaced nodes
    void PrepareLayout();
    /// Compute the node layout
    void ComputeLayout();

   public:
    /// Constructor
    SchemaGrid();

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
