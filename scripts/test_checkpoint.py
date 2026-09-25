import importlib.util
import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "checkpoint", Path(__file__).with_name("checkpoint.py")
)
checkpoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkpoint)


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source.db"
        self.db = sqlite3.connect(self.source)
        self.addCleanup(self.db.close)
        self.db.executescript("""
          CREATE TABLE games(id TEXT, status TEXT, config_json TEXT);
          CREATE TABLE events(game_id TEXT, sequence INTEGER, day INTEGER, phase TEXT, type TEXT);
          CREATE TABLE agent_records(game_id TEXT, record_key TEXT, value_json TEXT);
          CREATE TABLE provider_attempts(game_id TEXT, status TEXT, value_json TEXT);
        """)
        config = {
            "rules": {"firstCycle": "day_first"},
            "decisionEngine": {"mode": "jev", "workflow": "journal_v4"},
            "modelSettings": {
                "p1": {"provider": "openai", "model": "example", "reasoningEffort": "xhigh"}
            },
            "seed": "synthetic",
        }
        self.db.execute("INSERT INTO games VALUES(?,?,?)", ("game", "paused", json.dumps(config)))
        self.db.execute(
            "INSERT INTO events VALUES(?,?,?,?,?)", ("game", 12, 1, "night_team", "game.paused")
        )
        self.db.execute(
            "INSERT INTO provider_attempts VALUES(?,?,?)",
            ("game", "valid", json.dumps({"provider": "jev", "usage": {"totalTokens": 123}})),
        )
        self.db.commit()

    def capture(self):
        return checkpoint.capture(self.source, "game", self.root / "base", "a" * 40)

    def test_capture_and_fork_preserve_every_source_byte_and_do_not_mutate_base(self):
        before = checkpoint.digest(self.source)
        manifest = self.capture()
        self.assertEqual(checkpoint.digest(self.source), before)
        self.assertEqual(checkpoint.inspect(self.root / "base"), manifest)
        result = checkpoint.fork(self.root / "base", self.root / "run")
        self.assertEqual(result["baselineUsage"][0]["knownTokens"], 123)
        self.assertEqual(checkpoint.digest(Path(result["database"])), manifest["databaseSha256"])
        child = sqlite3.connect(result["database"])
        child.execute("UPDATE games SET status='running'")
        child.commit()
        child.close()
        self.assertEqual(checkpoint.inspect(self.root / "base"), manifest)
        self.assertEqual(checkpoint.digest(self.source), before)

    def test_rejects_old_workflow_and_incompatible_phase(self):
        self.db.execute(
            "UPDATE games SET config_json=json_set(config_json,'$.decisionEngine.workflow','journal_v3')"
        )
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "archived workflows"):
            self.capture()
        self.db.execute(
            "UPDATE games SET config_json=json_set(config_json,'$.decisionEngine.workflow','journal_v4')"
        )
        self.db.execute("UPDATE events SET phase='day_vote'")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "before any night work"):
            self.capture()

    def test_rejects_night_calls_and_unresolved_decisions(self):
        self.db.execute(
            "INSERT INTO events VALUES('game',11,1,'night_team','model.attempt_started')"
        )
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "Night work"):
            self.capture()
        self.db.execute("DELETE FROM events WHERE sequence=11")
        self.db.execute(
            "INSERT INTO agent_records VALUES('game','decision:a','{\"status\":\"pending\"}')"
        )
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "unresolved decisions"):
            self.capture()

    def test_detects_tampering_and_refuses_existing_destinations(self):
        self.capture()
        with self.assertRaises(FileExistsError):
            self.capture()
        checkpoint.fork(self.root / "base", self.root / "run")
        with self.assertRaises(FileExistsError):
            checkpoint.fork(self.root / "base", self.root / "run")
        database = self.root / "base" / "checkpoint.sqlite"
        database.chmod(0o600)
        database.write_bytes(database.read_bytes() + b"altered")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            checkpoint.fork(self.root / "base", self.root / "another")

    def test_cli_runs_via_shebang_and_rejects_mounted_paths(self):
        script = str(Path(__file__).with_name("checkpoint.py"))
        result = subprocess.run(
            [
                script,
                "capture",
                "--db",
                str(self.source),
                "--game",
                "game",
                "--out",
                str(self.root / "base"),
                "--source-revision",
                "a" * 40,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout)["phase"], "night_team")
        result = subprocess.run(
            [script, "fork", "--base", str(self.root / "base"), "--out", "/mnt/c/forbidden"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("native Linux", result.stderr)


if __name__ == "__main__":
    unittest.main()
