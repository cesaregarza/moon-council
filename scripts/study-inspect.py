#!/usr/bin/env python3
"""Inspect private speech-auction checkpoints without model calls or state changes."""

import argparse
import json
from pathlib import Path


def native(path):
    lexical = Path(path).absolute()
    if lexical == Path("/mnt") or Path("/mnt") in lexical.parents:
        raise ValueError("Use a native Linux path")
    result = lexical.resolve()
    if result == Path("/mnt") or Path("/mnt") in result.parents:
        raise ValueError("Use a native Linux path")
    return result


def summarize(state, scenario):
    target = state["run"]["targetId"]
    speeches = state["speeches"]
    own = [speech for speech in speeches if speech["playerId"] == target]

    # Match JavaScript string length independently, including surrogate pairs.
    def units(text):
        return len(text.encode("utf-16-le")) // 2

    total = sum(units(speech["text"]) for speech in speeches)
    answers = state["answers"]
    return {
        "id": state["run"]["id"],
        "status": state["status"],
        "turns": len(state["auctions"]),
        "targetId": target,
        "witnessId": state["run"]["witnessId"],
        "targetSpeeches": len(own),
        "targetTurns": [speech["turn"] for speech in own],
        "totalSpeeches": len(speeches),
        "floorShare": len(own) / len(speeches) if speeches else None,
        "characterShare": sum(units(speech["text"]) for speech in own) / total if total else None,
        "accuracy": sum(a["answer"] == scenario["correct"] for a in answers) / len(answers)
        if answers
        else None,
        "changedWinners": sum(a["selected"] != a["unforcedWinner"] for a in state["auctions"]),
        "error": state["error"],
    }


def verify_summary(row, analysis):
    expected = next(item for item in analysis["rows"] if item["id"] == row["id"])
    if row["status"] != "complete":
        assert all(value is None for value in expected["metrics"].values()), row["id"]
        return
    for key in ["floorShare", "characterShare", "accuracy"]:
        actual, reference = row[key], expected["metrics"][key]
        if actual is None or reference is None:
            assert actual is reference, (row["id"], key)
        else:
            assert abs(actual - reference) < 1e-12, (row["id"], key)
    assert row["changedWinners"] == expected["changedWinners"], row["id"]


def inspect(root, run_id=None, details=False, verify=False, turn=None):
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest["schemaVersion"] != "speech_auction_study_v1":
        raise ValueError("Unsupported study manifest")
    if verify and manifest.get("protocol", "free-floor-v1") != "free-floor-v1":
        raise ValueError(
            "Ratio verification supports free-floor-v1 only; inspect chain route scores separately"
        )
    analysis = json.loads((root / "analysis.json").read_text()) if verify else None
    rows = []
    for run in manifest["runs"]:
        if run_id is not None and run["id"] != run_id:
            continue
        if Path(run["id"]).name != run["id"]:
            raise ValueError("Invalid run path")
        path = native(root / run["id"] / "checkpoint.json")
        if not path.exists():
            rows.append({"id": run["id"], "status": "not_started"})
            continue
        state = json.loads(path.read_text())
        if state["run"] != run:
            raise ValueError("Checkpoint does not match manifest")
        scenario = next(s for s in manifest["scenarios"] if s["id"] == run["scenarioId"])
        row = summarize(state, scenario)
        if analysis is not None:
            verify_summary(row, analysis)
        if details:
            row["auctions"] = [a for a in state["auctions"] if turn is None or a["turn"] == turn]
            row["speeches"] = [s for s in state["speeches"] if turn is None or s["turn"] == turn]
            row["journals"] = [
                j for j in state["journals"] if turn is None or j["afterTurn"] == turn
            ]
            row["initialAnswers"] = state["initialAnswers"]
            row["answers"] = state["answers"]
        rows.append(row)
    if not rows:
        raise ValueError("No matching run")
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study", required=True, help="Private study directory")
    parser.add_argument("--run", help="One exact run ID; default is all runs")
    parser.add_argument("--details", action="store_true", help="Include private prose")
    parser.add_argument("--turn", type=int, help="Limit details to one turn and its reflections")
    parser.add_argument(
        "--verify", action="store_true", help="Cross-check frozen analysis.json ratios"
    )
    args = parser.parse_args()
    print(
        json.dumps(
            inspect(native(args.study), args.run, args.details, args.verify, args.turn), indent=2
        )
    )


if __name__ == "__main__":
    main()
