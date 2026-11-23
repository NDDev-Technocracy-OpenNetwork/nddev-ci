use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn run(source: &str, event: &str) -> (Self, Output) {
        Self::run_part(source, event, "")
    }

    fn run_part(source: &str, event: &str, part: &str) -> (Self, Output) {
        Self::run_on(source, event, part, "github-hosted")
    }

    fn run_on(source: &str, event: &str, part: &str, runner: &str) -> (Self, Output) {
        let path = std::env::temp_dir().join(format!(
            "nddev-ci-recipes-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("new owned fixture");
        let fixture = Self(path);
        fs::write(fixture.0.join("justfile"), source).expect("fixture justfile");
        let action =
            fs::read_to_string("actions/project-check/action.yml").expect("real check action");
        let script = action
            .split("# recipe-dispatch:begin")
            .nth(1)
            .expect("dispatch begins")
            .split("# recipe-dispatch:end")
            .next()
            .expect("dispatch ends")
            .lines()
            .map(|line| line.strip_prefix("        ").unwrap_or(line))
            .collect::<Vec<_>>()
            .join("\n");
        let output = Command::new("bash")
            .args(["-euo", "pipefail", "-c", &script])
            .env("EVENT", event)
            .env("PART", part)
            .env("SETUP", "false")
            .env("RUNNER_ENVIRONMENT", runner)
            .env("NDDEV_DOCKER_HOST", "unix:///run/fixture-docker.sock")
            .env("GITHUB_OUTPUT", fixture.0.join("outputs"))
            .env(
                "PROJECT_COMMAND",
                fs::canonicalize("lib/project-command.mjs").expect("real command observer"),
            )
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

    fn runner_reason(&self) -> String {
        fs::read_to_string(self.0.join("outputs")).unwrap_or_default()
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

#[test]
fn a_part_of_the_full_check_runs_only_its_recipes_in_order() {
    let (fixture, output) = Fixture::run_part(
        "verify: check image test-image\ncheck:\n    @echo check >> events\nimage:\n    @echo image >> events\ntest-image: image\n    @echo test-image >> events\n",
        "push",
        r#"["image","test-image"]"#,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fixture.events(), ["image", "test-image"]);
}

#[test]
fn a_part_passes_its_literal_arguments() {
    let (fixture, output) = Fixture::run_part(
        "test scope:\n    @echo test {{scope}} >> events\n",
        "push",
        r#"["test","unit tests"]"#,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fixture.events(), ["test unit tests"]);
}

#[test]
fn a_failing_part_stays_a_failure() {
    let (fixture, output) = Fixture::run_part(
        "a:\n    @echo a >> events\n    @false\n",
        "push",
        r#"["a"]"#,
    );
    assert!(!output.status.success());
    assert_eq!(fixture.events(), ["a"]);
}

#[test]
fn runner_docker_failures_are_recorded_and_the_project_check_still_fails() {
    let cases = [
        (
            r#""docker" "--host" "unix:///run/fixture-docker.sock" "buildx" "build" did not finish within 300 s"#,
            "docker-timeout",
        ),
        (
            r#"{"fields":{"event":"docker_proxy.request","route":"ping","status":502}}"#,
            "docker-unavailable",
        ),
        (
            r#"failed to copy: httpReadSeeker: failed open: failed to do request: Get "https://registry.example.test/v2/library/fixture/manifests/latest": net/http: timeout awaiting response headers"#,
            "docker-timeout",
        ),
    ];
    for (line, reason) in cases {
        let source =
            format!("check:\n    @echo 'started the test'\n    @echo '{line}' >&2\n    @exit 17\n");
        let (fixture, output) = Fixture::run_on(&source, "pull_request", "", "self-hosted");
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("started the test"));
        assert!(String::from_utf8_lossy(&output.stderr).contains(line));
        assert_eq!(fixture.runner_reason(), format!("runner-reason={reason}\n"));
    }
}

#[test]
fn a_successful_check_does_not_attribute_a_later_project_test_failure() {
    let (fixture, output) = Fixture::run_on(
        r#"check:
    @echo '"docker" "--host" "unix:///run/fixture-docker.sock" "buildx" "build" did not finish within 300 s' >&2
test:
    @echo 'project assertion failed' >&2
    @exit 17
"#,
        "pull_request",
        "",
        "self-hosted",
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("project assertion failed"));
    assert_eq!(fixture.runner_reason(), "");
}
