import importlib.util
import os
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
