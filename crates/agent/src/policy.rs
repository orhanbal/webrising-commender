use anyhow::{anyhow, Context, Result};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Clone)]
pub struct PathPolicy {
    roots: Vec<PathBuf>,
}

impl PathPolicy {
    pub fn new(roots: &[PathBuf]) -> Result<Self> {
        let mut canonical = Vec::new();
        for root in roots {
            let path = fs::canonicalize(root)
                .with_context(|| format!("cannot canonicalize allowed root {}", root.display()))?;
            canonical.push(path);
        }
        if canonical.is_empty() {
            return Err(anyhow!("no allowed roots configured"));
        }
        Ok(Self { roots: canonical })
    }

    pub fn resolve_existing(&self, raw: &str) -> Result<PathBuf> {
        let input = PathBuf::from(raw);
        reject_parent_components(&input)?;
        let canonical = fs::canonicalize(&input)
            .with_context(|| format!("path does not exist: {}", input.display()))?;
        self.ensure_allowed(&canonical)?;
        Ok(canonical)
    }

    pub fn resolve_for_create(&self, raw: &str) -> Result<PathBuf> {
        let input = PathBuf::from(raw);
        reject_parent_components(&input)?;

        // Path::exists follows symlinks and reports false for a dangling
        // symlink. Treating that path as absent would let a later write
        // follow the link to a target outside the allowed roots.
        match fs::symlink_metadata(&input) {
            Ok(_) => return self.resolve_existing(raw),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }

        let mut ancestor = input.as_path();
        let mut suffix: Vec<std::ffi::OsString> = Vec::new();

        loop {
            match fs::symlink_metadata(ancestor) {
                Ok(_) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let name = ancestor
                .file_name()
                .ok_or_else(|| anyhow!("cannot resolve parent for {}", input.display()))?;
            suffix.push(name.to_os_string());
            ancestor = ancestor
                .parent()
                .ok_or_else(|| anyhow!("cannot resolve parent for {}", input.display()))?;
        }

        let mut resolved = fs::canonicalize(ancestor)?;
        self.ensure_allowed(&resolved)?;

        for part in suffix.into_iter().rev() {
            resolved.push(part);
        }
        self.ensure_allowed_lexical(&resolved)?;
        Ok(resolved)
    }

    pub fn ensure_allowed(&self, path: &Path) -> Result<()> {
        if self.roots.iter().any(|root| path.starts_with(root)) {
            Ok(())
        } else {
            Err(anyhow!("path is outside configured allowed roots"))
        }
    }

    fn ensure_allowed_lexical(&self, path: &Path) -> Result<()> {
        if self.roots.iter().any(|root| path.starts_with(root)) {
            Ok(())
        } else {
            Err(anyhow!("path is outside configured allowed roots"))
        }
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }
}

fn reject_parent_components(path: &Path) -> Result<()> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(anyhow!("parent traversal components are not allowed"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs};
    use uuid::Uuid;

    #[test]
    fn rejects_parent_traversal() {
        let base = env::temp_dir().join(format!("commender-policy-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&base)).unwrap();
        assert!(policy.resolve_for_create("../escape").is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_symlink_create_outside_allowed_root() {
        use std::os::unix::fs::symlink;

        let base = env::temp_dir().join(format!("commander-dangling-{}", Uuid::new_v4()));
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let link = allowed.join("new-file");
        let target = outside.join("missing-file");
        symlink(&target, &link).unwrap();

        let policy = PathPolicy::new(std::slice::from_ref(&allowed)).unwrap();
        assert!(policy.resolve_for_create(link.to_str().unwrap()).is_err());
        assert!(!target.exists());

        // An intermediate dangling link must not be mistaken for a missing
        // directory either.
        let intermediate = allowed.join("new-dir");
        symlink(outside.join("missing-dir"), &intermediate).unwrap();
        assert!(policy
            .resolve_for_create(intermediate.join("file").to_str().unwrap())
            .is_err());

        // Legitimate new files within the root still resolve normally.
        assert_eq!(
            policy
                .resolve_for_create(allowed.join("ordinary").to_str().unwrap())
                .unwrap(),
            allowed.join("ordinary")
        );
        fs::remove_dir_all(base).unwrap();
    }
}
