//! Reads the scripts named on the command line

use crate::lint::Input;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// The path that reads a script from stdin
pub const STDIN: &str = "-";

/// Catalog files that notebooks keep next to their scripts, they describe the connection and are not meant to run.
/// `dashql-functions.sql` and `dashql-relations.sql` are their names in older versions.
const GENERATED_FILES: [&str; 5] = [
    "dashql-catalog-changes.sql",
    "dashql-catalog-functions.sql",
    "dashql-catalog-relations.sql",
    "dashql-functions.sql",
    "dashql-relations.sql",
];

/// The directory the user invoked the CLI from. Under `bazel run` the process runs in the runfiles tree.
fn working_directory() -> std::io::Result<PathBuf> {
    match std::env::var_os("BUILD_WORKING_DIRECTORY") {
        Some(dir) => Ok(dir.into()),
        None => std::env::current_dir(),
    }
}

/// Remove `.` and `..` components without touching the file system
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

/// Paths relative to the invoking directory, absolute ones for files outside of it
fn display_path(path: &Path, cwd: &Path) -> String {
    match path.strip_prefix(cwd) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.display().to_string(),
        _ => path.display().to_string(),
    }
}

/// The *.sql files under a directory, in file name order
fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    let mut entries = std::fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Follow symlinks, SQL libraries are often linked into place
        let Ok(info) = std::fs::metadata(&path) else { continue };
        if info.is_dir() {
            if name != "node_modules" && !name.starts_with('.') {
                walk(&path, out)?;
            }
        } else if info.is_file() && name.to_lowercase().ends_with(".sql") && !GENERATED_FILES.contains(&&*name) {
            out.push(path);
        }
    }
    Ok(())
}

fn with_path<T>(path: &Path, result: std::io::Result<T>) -> Result<T, String> {
    result.map_err(|e| format!("{}: {e}", path.display()))
}

/// Read SQL scripts from files, directories (recursively, *.sql only, without generated catalog files) and stdin
/// (`-`). Scripts are identified by their path relative to the invoking directory, each is read once.
pub fn read_inputs(paths: &[String]) -> Result<Vec<Input>, String> {
    let cwd = working_directory().map_err(|e| format!("working directory: {e}"))?;
    let mut inputs = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        if path == STDIN {
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).map_err(|e| format!("stdin: {e}"))?;
            if seen.insert("<stdin>".to_string()) {
                inputs.push(Input { id: "<stdin>".into(), text: String::from_utf8_lossy(&bytes).into_owned() });
            }
            continue;
        }
        let root = normalize(&cwd.join(path));
        let mut files = Vec::new();
        if with_path(&root, std::fs::metadata(&root))?.is_dir() {
            with_path(&root, walk(&root, &mut files))?;
        } else {
            files.push(root);
        }
        for file in files {
            let id = display_path(&file, &cwd);
            if seen.insert(id.clone()) {
                let bytes = with_path(&file, std::fs::read(&file))?;
                inputs.push(Input { id, text: String::from_utf8_lossy(&bytes).into_owned() });
            }
        }
    }
    Ok(inputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_paths_lexically() {
        assert_eq!(normalize(Path::new("/a/./b/../c.sql")), Path::new("/a/c.sql"));
        assert_eq!(display_path(Path::new("/a/b/c.sql"), Path::new("/a")), "b/c.sql");
        assert_eq!(display_path(Path::new("/x/c.sql"), Path::new("/a")), "/x/c.sql");
        assert_eq!(display_path(Path::new("/a"), Path::new("/a")), "/a");
    }

    #[test]
    fn walks_sql_files_in_name_order() {
        let root = PathBuf::from(std::env::var_os("TEST_TMPDIR").unwrap_or_else(|| std::env::temp_dir().into()))
            .join("dashql_cli_walk");
        let _ = std::fs::remove_dir_all(&root);
        for file in [
            "b.sql",
            "a.SQL",
            "notes.txt",
            "dashql-relations.sql",
            "dashql-catalog-relations.sql",
            "dashql-catalog-changes.sql",
            "sub/c.sql",
            ".hidden/d.sql",
            "node_modules/e.sql",
        ] {
            let path = root.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "select 1;").unwrap();
        }
        let mut files = Vec::new();
        walk(&root, &mut files).unwrap();
        let files: Vec<_> = files.iter().map(|f| display_path(f, &root)).collect();
        assert_eq!(files, ["a.SQL", "b.sql", "sub/c.sql"]);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
