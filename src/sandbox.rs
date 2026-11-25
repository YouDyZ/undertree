//! Landlock filesystem sandbox for untrusted TeX runs.
//!
//! TeX documents are code: LuaTeX's `io.open` and pdfTeX/XeTeX `\input` can read any file the
//! server user can (DB, `secret.key`, other projects, `/proc/1/environ` with OAuth secrets).
//! The compiler therefore runs in a Landlock domain that may only read the system (TeX Live,
//! perl, libs) and write its own build directory. `/proc`, `$UNDERTREE_DATA` and `/home` are
//! not reachable.
//!
//! Landlock restricts the calling *thread* and everything it spawns, so each run gets a fresh
//! OS thread that restricts itself, spawns the child and waits; the server stays unrestricted.

use std::{
    io,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::mpsc,
};

use landlock::{
    path_beneath_rules, Access, AccessFs, CompatLevel, Compatible, Ruleset, RulesetAttr,
    RulesetCreatedAttr, RulesetStatus, ABI,
};

/// Read-only (and executable) roots: TeX Live (`/usr/local/texlive`), perl, shared libs,
/// fontconfig in `/etc`. Missing paths are skipped.
const READ_ONLY: &[&str] = &["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"];

/// Writable besides `rw`: sinks that tools open for writing.
const DEVICES: &[&str] = &["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"];

fn restrict(dir: &Path, writable: bool) -> Result<(), String> {
    let abi = ABI::V3;
    let existing = |paths: &[&str]| -> Vec<PathBuf> {
        paths
            .iter()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .collect()
    };
    let status = Ruleset::default()
        // at least ABI v1 must be enforced; newer rights (truncate, refer) are best effort
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(AccessFs::from_all(abi))
        .and_then(|r| r.create())
        .and_then(|r| {
            r.add_rules(path_beneath_rules(
                existing(READ_ONLY),
                AccessFs::from_read(abi),
            ))
        })
        .and_then(|r| {
            r.add_rules(path_beneath_rules(
                existing(DEVICES),
                AccessFs::from_all(abi),
            ))
        })
        .and_then(|r| {
            let access = if writable {
                AccessFs::from_all(abi)
            } else {
                AccessFs::from_read(abi)
            };
            r.add_rules(path_beneath_rules([dir], access))
        })
        .and_then(|r| r.restrict_self())
        .map_err(|e| format!("sandbox setup failed: {e}"))?;
    if status.ruleset == RulesetStatus::NotEnforced {
        return Err("sandbox unavailable: kernel without Landlock support".into());
    }
    Ok(())
}

/// Spawns `cmd` confined to read-only system paths plus `dir` (read-write if `writable`).
/// Returns the child's pid and a receiver for its output.
pub fn spawn(
    mut cmd: Command,
    dir: PathBuf,
    writable: bool,
) -> Result<(u32, mpsc::Receiver<io::Result<Output>>), String> {
    let (pid_tx, pid_rx) = mpsc::channel();
    let (out_tx, out_rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("tex-sandbox".into())
        .spawn(move || {
            let child = restrict(&dir, writable).and_then(|()| {
                cmd.spawn()
                    .map_err(|e| format!("compiler could not be started: {e}"))
            });
            match child {
                Ok(child) => {
                    let _ = pid_tx.send(Ok(child.id()));
                    let _ = out_tx.send(child.wait_with_output());
                }
                Err(e) => {
                    let _ = pid_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| format!("sandbox thread: {e}"))?;
    let pid = pid_rx
        .recv()
        .map_err(|_| "sandbox thread died".to_owned())??;
    Ok((pid, out_rx))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `None` if this kernel has no Landlock (CI runners): production then refuses to compile.
    fn run(script: &str, rw: &Path, writable: bool) -> Option<Output> {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        match spawn(cmd, rw.to_owned(), writable) {
            Ok((_, rx)) => Some(rx.recv().unwrap().unwrap()),
            Err(e) if e.contains("sandbox unavailable") => {
                eprintln!("skipping: {e}");
                None
            }
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn confines_reads_and_writes() {
        let tmp = tempfile::tempdir().unwrap();
        let rw = tmp.path().join("build");
        std::fs::create_dir(&rw).unwrap();
        let secret = tmp.path().join("secret.key");
        std::fs::write(&secret, "s3cret").unwrap();

        let Some(out) = run(
            &format!(
                "cat {s} ; cat /proc/self/environ ; echo ok > {rw}/x && cat {rw}/x ; \
                 echo no > {t}/escape ; ls /usr/bin/env",
                s = secret.display(),
                rw = rw.display(),
                t = tmp.path().display()
            ),
            &rw,
            true,
        ) else {
            return;
        };
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(!stdout.contains("s3cret"), "{stdout}");
        assert!(stdout.contains("ok"), "build dir writable: {stdout}");
        assert!(stdout.contains("/usr/bin/env"), "system readable: {stdout}");
        assert!(!tmp.path().join("escape").exists());
        // /proc is not in the allow list: no env of the server (pid 1 in the container)
        assert!(!stdout.contains("PATH="), "{stdout}");
        // the calling (test) thread is not restricted
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "s3cret");
    }

    #[test]
    fn read_only_dir() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("in"), "data").unwrap();
        let script = format!("cat {d}/in ; echo x > {d}/out", d = tmp.path().display());
        let Some(out) = run(&script, tmp.path(), false) else {
            return;
        };
        assert_eq!(String::from_utf8_lossy(&out.stdout), "data");
        assert!(!tmp.path().join("out").exists());
    }
}
