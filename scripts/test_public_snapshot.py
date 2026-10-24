import base64
import gzip
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "snapshot", Path(__file__).with_name("public-snapshot.py")
)
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTests(unittest.TestCase):
    def test_excludes_private_artifacts(self):
        for path in [
            ".env",
            "apps/api/.env.production",
            "data/pilots/one/research.json",
            "docs/research/report.md",
            "docs/HANDOFF_V3_2.md",
            "compose.pi.yaml",
            "scripts/deploy-pi.sh",
            "apps/api/src/old.ts.orig",
            "packages/x/private.key",
            "scripts/__pycache__/x.pyc",
        ]:
            self.assertFalse(snapshot.allowed(path), path)
        for path in [
            ".env.example",
            "packages/llm/src/jev.ts",
            "docs/ACTOR_WORKFLOW.md",
            "docs/ARCHITECTURE.md",
            "docs/SPEAKER_AUCTION.md",
            "docs/AUCTION_TESTING.md",
            "docs/RUNNING.md",
            "docs/REFERENCE.md",
            "CONTRIBUTING.md",
            ".editorconfig",
            ".prettierrc.json",
            ".prettierignore",
            ".oxlintrc.json",
            "requirements-dev.txt",
            "ruff.toml",
            ".github/workflows/checks.yml",
        ]:
            self.assertTrue(snapshot.allowed(path), path)

    def test_findings_are_locations_not_secret_values(self):
        secret = "sk-" + "a" * 40
        result = snapshot.findings("OPENAI_API_KEY=" + secret)
        self.assertTrue(result)
        self.assertNotIn(secret, str(result))
        self.assertTrue(snapshot.findings("host=100." + "85.230.40"))
        self.assertFalse(snapshot.findings('"concurrently": "10.0.5"'))

    def test_scrub_removes_local_setup_and_ignores_runtime_data(self):
        private_path = "/" + "home/" + "example/private-project"
        source = ("cd " + private_path + "\nSee docs/VERIFICATION_V3.md\n").encode()
        with patch.dict(
            os.environ, {"PUBLIC_SNAPSHOT_REPLACEMENTS": '{"' + private_path + '":"moon-council"}'}
        ):
            text = snapshot.sanitize("README.md", source).decode()
        self.assertNotIn(private_path, text)
        self.assertNotIn("VERIFICATION", text)
        self.assertIn("data/", snapshot.sanitize(".gitignore", b"").decode())

    def test_personal_paths_are_detected_without_printing_them(self):
        for root in ["root", "home", "Users"]:
            private = "/" + root + "/example/notes.txt"
            result = snapshot.findings(private)
            self.assertTrue(result)
            self.assertNotIn(private, str(result))

    def test_history_scan_decodes_compressed_fixtures(self):
        # CES-1558: compressed fixtures are base64 text; the scan must read what they decode to.
        private_path = "/" + "home/" + "example/private-project"
        payload = json.dumps({"note": "cd " + private_path}).encode()
        packed = base64.encodebytes(gzip.compress(payload, mtime=0)).decode()
        with tempfile.TemporaryDirectory() as repo:
            name = "packages/simulator/src/testing/compat-fixtures/planted.json.gz.b64"
            (Path(repo) / name).parent.mkdir(parents=True)
            (Path(repo) / name).write_text(packed)
            git = ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
            subprocess.run(git + ["init", "-q"], check=True)
            subprocess.run(git + ["add", "."], check=True)
            subprocess.run(git + ["-c", "commit.gpgsign=false", "commit", "-qm", "f"], check=True)
            run = subprocess.run(
                [
                    "python3",
                    str(Path(__file__).with_name("public-snapshot.py")),
                    "--source",
                    repo,
                    "--verify-history",
                ],
                capture_output=True,
                text=True,
            )
        report = json.loads(run.stdout)
        self.assertEqual(run.returncode, 1, run.stdout)
        self.assertIn(
            {"path": name, "rule": "personal-path"},
            [{"path": f["path"], "rule": f["rule"]} for f in report["findings"]],
        )
        self.assertNotIn(private_path, run.stdout)

    # CES-1558 round 3: an encoded fixture is accepted only in its exact canonical form (strict
    # base64 in 76-character lines, one gzip stream, valid JSON), in the history scan and in
    # export alike. Anything else is a finding, and export writes nothing.
    FIXTURE = "packages/simulator/src/testing/compat-fixtures/planted.json.gz.b64"
    PRIVATE_PATH = "/" + "home/" + "example/private-project"

    def scan_both(self, content):
        """Commits `content` as an encoded fixture in a throwaway repository, then runs the
        history scan and an export over it. Returns both runs and the exported bytes, if any."""
        script = str(Path(__file__).with_name("public-snapshot.py"))
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as out:
            (Path(repo) / self.FIXTURE).parent.mkdir(parents=True)
            (Path(repo) / self.FIXTURE).write_text(content)
            git = ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
            subprocess.run(git + ["init", "-q"], check=True)
            subprocess.run(git + ["add", "."], check=True)
            subprocess.run(git + ["-c", "commit.gpgsign=false", "commit", "-qm", "f"], check=True)
            history, export = (
                subprocess.run(
                    ["python3", script, "--source", repo, *args], capture_output=True, text=True
                )
                for args in (["--verify-history"], ["--output", out])
            )
            written = Path(out) / self.FIXTURE
            return history, export, written.read_bytes() if written.exists() else None

    def report(self, run):
        try:
            return json.loads(run.stdout)
        except ValueError:
            self.fail(f"no findings report (exit {run.returncode}): {run.stderr[-300:]}")

    def assert_rejected(self, content):
        history, export, written = self.scan_both(content)
        rules = []
        for run in (history, export):
            self.assertNotIn(self.PRIVATE_PATH, run.stdout + run.stderr)
            self.assertEqual(run.returncode, 1, run.stdout)
            findings = self.report(run)["findings"]
            self.assertTrue(findings, run.stdout)
            self.assertEqual({f["path"] for f in findings}, {self.FIXTURE})
            rules.append(sorted(f["rule"] for f in findings))
        self.assertEqual(rules[0], rules[1], "export must agree with the history scan")
        self.assertIsNone(written, "export must write nothing")

    def gzipped(self, value):
        return gzip.compress(json.dumps(value).encode(), mtime=0)

    def test_encoded_fixture_rejects_data_after_padding(self):
        # A clean fixture that ends in padding, followed by a second encoded payload.
        clean = next(packed for n in range(64) if len(packed := self.gzipped({"ok": "x" * n})) % 3)
        hidden = self.gzipped({"note": "cd " + self.PRIVATE_PATH})
        content = base64.encodebytes(clean).decode() + base64.encodebytes(hidden).decode()
        self.assertTrue(base64.encodebytes(clean).decode().rstrip().endswith("="))
        self.assert_rejected(content)

    def test_encoded_fixture_rejects_an_empty_file(self):
        self.assert_rejected("")

    def test_encoded_fixture_rejects_a_punctuation_only_file(self):
        self.assert_rejected("!!!!\n")

    def test_encoded_fixture_rejects_non_gzip_payloads(self):
        # Base64 of plain JSON, and of a gzip header followed by bytes that are not deflate data.
        for payload in (b'{"ok": 1}', self.gzipped({"ok": 1})[:10] + b"\xff" * 16):
            with self.subTest(payload=payload[:12]):
                self.assert_rejected(base64.encodebytes(payload).decode())

    def test_encoded_fixture_rejects_trailing_bytes_after_the_gzip_stream(self):
        self.assert_rejected(base64.encodebytes(self.gzipped({"ok": 1}) + b"\0" * 8).decode())

    def test_encoded_fixture_rejects_text_that_is_not_json(self):
        not_json = gzip.compress(b"not json", mtime=0)
        self.assert_rejected(base64.encodebytes(not_json).decode())

    def test_encoded_fixture_rejects_noncanonical_base64(self):
        # Valid content, but one long line instead of 76-character lines.
        payload = self.gzipped({"ok": [n * 7919 % 1000 for n in range(200)]})
        self.assertGreater(len(payload), 57)
        self.assert_rejected(base64.b64encode(payload).decode() + "\n")

    def test_export_matches_history_for_a_canonical_fixture(self):
        content = base64.encodebytes(self.gzipped({"ok": 1})).decode()
        history, export, written = self.scan_both(content)
        self.assertEqual((history.returncode, export.returncode), (0, 0), history.stdout)
        self.assertEqual(written, content.encode())

    def test_bare_private_hostnames_are_detected(self):
        host = "local-machine." + "test." + "ts" + ".net"
        self.assertTrue(snapshot.findings(host))
        clean = snapshot.sanitize(
            "apps/web/vite.config.ts", ('allowedHosts: ["' + host + '"],').encode()
        )
        self.assertNotIn(host, clean.decode())

    def test_refuses_mounted_paths(self):
        with self.assertRaises(ValueError):
            snapshot.native("/mnt/c")


if __name__ == "__main__":
    unittest.main()
