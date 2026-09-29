"""Checks for the independent, read-only study inspector."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "study_inspect", Path(__file__).with_name("study-inspect.py")
)
INSPECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSPECTOR)


def fixture():
    return {
        "run": {"id": "sample", "targetId": "p1", "witnessId": "p2", "scenarioId": "case"},
        "status": "complete",
        "error": None,
        "speeches": [
            {"playerId": "p1", "turn": 1, "text": "a😀"},
            {"playerId": "p2", "turn": 2, "text": "abc"},
        ],
        "auctions": [{"turn": 1, "selected": "p1", "unforcedWinner": "p2"}],
        "answers": [{"answer": "yes"}, {"answer": "no"}],
        "initialAnswers": [],
        "journals": [{"afterTurn": 1, "journal": "private note"}],
    }


class StudyInspectorTests(unittest.TestCase):
    def test_denominators_and_utf16(self):
        row = INSPECTOR.summarize(fixture(), {"correct": "yes"})
        self.assertEqual(row["floorShare"], 0.5)
        self.assertEqual(row["characterShare"], 0.5)
        self.assertEqual(row["accuracy"], 0.5)
        self.assertEqual(row["changedWinners"], 1)
        self.assertEqual(row["targetTurns"], [1])

    def test_missing_is_not_zero(self):
        state = fixture()
        state["speeches"] = []
        state["answers"] = []
        row = INSPECTOR.summarize(state, {"correct": "yes"})
        for key in ["floorShare", "characterShare", "accuracy"]:
            self.assertIsNone(row[key])

    def test_read_only_and_explicit_private_details(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = fixture()
            manifest = {
                "schemaVersion": "speech_auction_study_v1",
                "runs": [state["run"]],
                "scenarios": [{"id": "case", "correct": "yes"}],
            }
            (root / "manifest.json").write_text(json.dumps(manifest))
            (root / "sample").mkdir()
            path = root / "sample" / "checkpoint.json"
            path.write_text(json.dumps(state))
            before = path.read_bytes()
            self.assertNotIn("private note", json.dumps(INSPECTOR.inspect(root)))
            details = INSPECTOR.inspect(root, details=True, turn=1)[0]
            self.assertEqual(len(details["journals"]), 1)
            self.assertEqual(len(details["speeches"]), 1)
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaises(ValueError):
                INSPECTOR.inspect(root, run_id="missing")

    def test_detects_a_wrong_derived_ratio(self):
        row = INSPECTOR.summarize(fixture(), {"correct": "yes"})
        expected = {
            "rows": [
                {
                    "id": "sample",
                    "metrics": {
                        "floorShare": 0.8,
                        "characterShare": 0.5,
                        "accuracy": 0.5,
                    },
                    "changedWinners": 1,
                }
            ]
        }
        with self.assertRaises(AssertionError):
            INSPECTOR.verify_summary(row, expected)

    def test_rejects_mount_lexically(self):
        with self.assertRaises(ValueError):
            INSPECTOR.native("/mnt/forbidden-study")


if __name__ == "__main__":
    unittest.main()
