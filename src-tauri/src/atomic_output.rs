use std::{
    fs::{self, File, OpenOptions},
    io,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_OUTPUT: AtomicU64 = AtomicU64::new(0);

pub fn replace_output(
    destination: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let (temporary, mut file) = loop {
        let name = format!(
            ".orei-export-{}-{}.tmp",
            std::process::id(),
            NEXT_OUTPUT.fetch_add(1, Ordering::Relaxed)
        );
        let path = parent.join(name);
        match OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path) {
            Ok(file) => break (path, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    let result = (|| {
        write(&mut file)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::Write,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "orei-output-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn an_existing_export_survives_a_partial_write_failure() {
        let directory = TestDirectory::new();
        let destination = directory.0.join("diagram.svg");
        fs::write(&destination, b"previous valid export").unwrap();

        let result = replace_output(&destination, |file| {
            file.write_all(b"partial")?;
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "injected write failure",
            ))
        });

        assert!(result.is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"previous valid export");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn a_complete_export_replaces_the_old_file_without_temporary_files() {
        let directory = TestDirectory::new();
        let destination = directory.0.join("diagram.svg");
        fs::write(&destination, b"old export").unwrap();

        replace_output(&destination, |file| file.write_all(b"complete new export")).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"complete new export");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn a_failed_new_export_leaves_no_partial_destination() {
        let directory = TestDirectory::new();
        let destination = directory.0.join("diagram.svg");

        let result = replace_output(&destination, |file| {
            file.write_all(b"partial")?;
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "injected write failure",
            ))
        });

        assert!(result.is_err());
        assert!(!destination.exists());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    }

    #[test]
    fn a_failed_replacement_keeps_the_destination_and_cleans_the_temporary_file() {
        let directory = TestDirectory::new();
        let destination = directory.0.join("diagram.svg");
        fs::create_dir(&destination).unwrap();

        let result = replace_output(&destination, |file| file.write_all(b"complete export"));

        assert!(result.is_err());
        assert!(destination.is_dir());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }
}
