/// File names of an atlas index in the selected folder, one Parquet file per embedding space
export const ATLAS_STRUCTURE_FILE = 'dashql-atlas-structure.parquet';
export const ATLAS_DESCRIPTION_FILE = 'dashql-atlas-description.parquet';
export const ATLAS_PROPERTIES_FILE = 'dashql-atlas-properties.parquet';
export const ATLAS_INDEX_FILES = [ATLAS_STRUCTURE_FILE, ATLAS_DESCRIPTION_FILE, ATLAS_PROPERTIES_FILE];
/// Index files of earlier versions that are removed when a folder is indexed again
export const ATLAS_STALE_FILES = ['dashql-atlas-comments.parquet', 'dashql-atlas-features.parquet', 'dashql-atlas-index.json'];
