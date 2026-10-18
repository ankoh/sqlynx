/// File name of the atlas index in the selected folder
export const ATLAS_INDEX_FILE = 'dashql-atlas.parquet';
/// Index files of earlier versions that are removed when a folder is indexed again
export const ATLAS_STALE_FILES = [
    'dashql-atlas-structure.parquet',
    'dashql-atlas-description.parquet',
    'dashql-atlas-properties.parquet',
    'dashql-atlas-comments.parquet',
    'dashql-atlas-features.parquet',
    'dashql-atlas-index.json',
];
