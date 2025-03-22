#pragma once

#include <unordered_set>

#include "dashql/parser/parser.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/script.h"
#include "dashql/utils/btree/map.h"
#include "dashql/utils/chunk_buffer.h"
#include "dashql/utils/string_pool.h"

namespace dashql {

struct FileSearchLabel {
    /// The id of the indexed file
    size_t local_file_id;
    /// The label text
    std::string_view text;
    /// The location in the source file
    sx::Location location;
};

struct IndexedFile {
    /// The id of the file
    size_t local_id;
    /// The name of the file
    std::string name;
};

struct IndexedFileStatistics {
    /// The label count
    size_t label_count = 0;
    /// Plus operator
    IndexedFileStatistics operator+(IndexedFileStatistics other) {
        return {.label_count = label_count + other.label_count};
    }
    /// Plus operator
    IndexedFileStatistics operator-(IndexedFileStatistics other) {
        return {.label_count = label_count - other.label_count};
    }
};

struct SearchIndex {
    /// The index type
    using SearchIndexType = btree::multimap<std::string_view, std::reference_wrapper<const FileSearchLabel>>;

   protected:
    /// The indexed files
    std::unordered_map<std::string, IndexedFile> indexed_files;
    /// The tombstones for indexed files that were deleted
    std::unordered_set<size_t> indexed_files_tombstones;
    /// The statistics of all files that are indexed
    IndexedFileStatistics index_stats_total;
    /// The statistics of dead files that are indexed
    IndexedFileStatistics index_stats_dead;

    /// The string pool for labels
    StringPool<1024> label_string_pool;
    /// The label strings
    std::unordered_set<std::string_view> label_strings;
    /// The file labels
    ChunkBuffer<FileSearchLabel, 32> file_labels;
    /// The label suffixes
    SearchIndexType search_index;

    /// Compact the search index by rebuilding the search labels
    void Compact();

   public:
    /// Constructor
    SearchIndex();

    /// Add a file to the search index
    void AddFile(std::string_view filename, ScannedScript& script);
    /// Remove a file from the search indexjA
    void RemoveFile(std::string_view filename);
    /// Search file
    void SearchFile(std::string_view text);
};

}  // namespace dashql
