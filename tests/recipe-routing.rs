use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn run(source: &str, event: &str) -> (Self, Output) {
        let path = std::env::temp_dir().join(format!(
            "nddev-ci-recipes-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("new owned fixture");
        let fixture = Self(path);
        fs::write(fixture.0.join("justfile"), source).expect("fixture justfile");
        let workflow = fs::read_to_string(".github/workflows/check.yml").expect("real workflow");
        let script = workflow
            .split("# recipe-dispatch:begin")
            .nth(1)
            .expect("dispatch begins")
            .split("# recipe-dispatch:end")
            .next()
            .expect("dispatch ends")
            .lines()
            .map(|line| line.strip_prefix("          ").unwrap_or(line))
            .collect::<Vec<_>>()
            .join("\n");
        let output = Command::new("bash")
            .args(["-euo", "pipefail", "-c", &script])
            .env("EVENT", event)
            .current_dir(&fixture.0)
            .output()
            .expect("execute actual recipe dispatch");
        (fixture, output)
    }

    fn events(&self) -> Vec<String> {
        fs::read_to_string(self.0.join("events"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove owned fixture");
    }
}

#[test]
fn a_check_only_repository_does_not_need_a_dummy_test() {
    let (fixture, output) = Fixture::run("check:\n    @echo check >> events\n", "pull_request");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fixture.events(), ["check"]);
}

#[test]
fn a_declared_test_is_run_after_the_check() {
    let (fixture, output) = Fixture::run(
        "check:\n    @echo check >> events\ntest:\n    @echo test >> events\n",
        "pull_request",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fixture.events(), ["check", "test"]);
}

#[test]
fn a_test_alias_is_a_declared_test() {
    let (fixture, output) = Fixture::run(
        "alias test := actual\ncheck:\n    @echo check >> events\nactual:\n    @echo test >> events\n",
        "pull_request",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fixture.events(), ["check", "test"]);
}

#[test]
fn a_failing_test_stays_a_failure() {
    let (fixture, output) = Fixture::run(
        "check:\n    @echo check >> events\ntest:\n    @echo test >> events\n    @false\n",
        "pull_request",
    );
    assert!(!output.status.success());
    assert_eq!(fixture.events(), ["check", "test"]);
}

#[test]
fn a_failing_check_never_starts_tests() {
    let (fixture, output) = Fixture::run(
        "check:\n    @echo check >> events\n    @false\ntest:\n    @echo test >> events\n",
        "pull_request",
    );
    assert!(!output.status.success());
    assert_eq!(fixture.events(), ["check"]);
}

#[test]
fn a_failed_justfile_parse_is_not_misreported_as_no_tests() {
    let (_fixture, output) = Fixture::run(
        "check:\n    @echo 'not a valid justfile' > justfile\n",
        "pull_request",
    );
    assert!(!output.status.success());
}

#[test]
fn the_full_path_still_runs_verify() {
    let (fixture, output) = Fixture::run(
        "check:\n    @echo check >> events\ntest:\n    @echo test >> events\nverify:\n    @echo verify >> events\n",
        "push",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fixture.events(), ["verify"]);
}
