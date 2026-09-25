#!/usr/bin/env python3
"""Capture an immutable Day 1 base and fork independent, writable pilot databases."""

import argparse
from contextlib import closing
import hashlib
import json
import re
import shutil
import sqlite3
from pathlib import Path

SCHEMA = "moon_council_day1_base_v1"


def native(value):
    raw = Path(value).absolute()
    if raw == Path("/mnt") or Path("/mnt") in raw.parents:
        raise ValueError("Use native Linux paths")
    path = raw.resolve()
    if path == Path("/mnt") or Path("/mnt") in path.parents:
        raise ValueError("Mounted paths and symlinks into them are forbidden")
    return path


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def connect(path, immutable=False):
    suffix = "?mode=ro" + ("&immutable=1" if immutable else "")
    return sqlite3.connect(path.as_uri() + suffix, uri=True)


def describe(connection, game_id):
    row = connection.execute(
        "SELECT status,config_json FROM games WHERE id=?", (game_id,)
    ).fetchone()
    if not row:
        raise ValueError("Unknown game")
    config = json.loads(row[1])
    last = connection.execute(
        "SELECT sequence,day,phase FROM events WHERE game_id=? ORDER BY sequence DESC LIMIT 1",
        (game_id,),
    ).fetchone()
    if row[0] != "paused" or not last or last[1:] != (1, "night_team"):
        raise ValueError("Base must be paused at Night 1 before any night work")
    engine = config.get("decisionEngine", {})
    if (
        config.get("rules", {}).get("firstCycle") != "day_first"
        or engine.get("mode") != "jev"
        or engine.get("workflow") != "journal_v4"
    ):
        raise ValueError(
            "Base requires day-first Jev journal_v4; archived workflows cannot be relabeled"
        )
    night_work = connection.execute(
        "SELECT count(*) FROM events WHERE game_id=? AND day=1 AND phase LIKE 'night_%' AND type IN ('model.attempt_started','team.point','team.agreement_frozen','night.action_submitted','night.resolved')",
        (game_id,),
    ).fetchone()[0]
    pending = connection.execute(
        "SELECT count(*) FROM agent_records WHERE game_id=? AND record_key LIKE 'decision:%' AND json_extract(value_json,'$.status') NOT IN ('committed','superseded')",
        (game_id,),
    ).fetchone()[0]
    inflight = connection.execute(
        "SELECT count(*) FROM provider_attempts WHERE game_id=? AND status IN ('started','received')",
        (game_id,),
    ).fetchone()[0]
    if night_work or pending or inflight:
        raise ValueError("Night work or unresolved decisions prevent a reusable Day 1 base")
    counts = connection.execute(
        "SELECT provider,count(*),sum(coalesce(json_extract(value_json,'$.usage.totalTokens'),0)) FROM (SELECT json_extract(value_json,'$.provider') AS provider,value_json FROM provider_attempts WHERE game_id=?) GROUP BY provider ORDER BY provider",
        (game_id,),
    ).fetchall()
    return {
        "gameId": game_id,
        "status": row[0],
        "day": last[1],
        "phase": last[2],
        "eventSequence": last[0],
        "configSha256": hashlib.sha256(row[1].encode()).hexdigest(),
        "decisionEngine": engine,
        "modelSettings": config.get("modelSettings"),
        "seed": config.get("seed"),
        "baselineUsage": [
            {"provider": provider, "calls": count, "knownTokens": tokens}
            for provider, count, tokens in counts
        ],
    }


def capture(db, game_id, output, revision):
    if not re.fullmatch("[a-f0-9]{40}", revision):
        raise ValueError("Supply the exact 40-character source revision")
    source, output = native(db), native(output)
    with closing(connect(source)) as reader:
        reader.execute("BEGIN")
        metadata = describe(reader, game_id)
        output.mkdir(mode=0o700, parents=False, exist_ok=False)
        target = output / "checkpoint.sqlite"
        with closing(sqlite3.connect(target)) as writer:
            reader.backup(writer)
            if writer.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Checkpoint integrity check failed")
            if describe(writer, game_id) != metadata:
                raise ValueError("Checkpoint metadata changed during capture")
    manifest = {
        "schema": SCHEMA,
        "sourceRevision": revision,
        "databaseSha256": digest(target),
        **metadata,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    target.chmod(0o444)
    (output / "manifest.json").chmod(0o444)
    output.chmod(0o555)
    return manifest


def inspect(base):
    base = native(base)
    manifest = json.loads((base / "manifest.json").read_text())
    if manifest.get("schema") != SCHEMA:
        raise ValueError("Unknown checkpoint manifest")
    database = base / "checkpoint.sqlite"
    if digest(database) != manifest.get("databaseSha256"):
        raise ValueError("Base database checksum mismatch; refusing to use altered evidence")
    with closing(connect(database, immutable=True)) as reader:
        current = describe(reader, manifest["gameId"])
    if any(manifest.get(key) != value for key, value in current.items()):
        raise ValueError("Manifest does not match the checkpoint")
    return manifest


def fork(base, output):
    base, output = native(base), native(output)
    manifest = inspect(base)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    database = output / "game.db"
    shutil.copyfile(base / "checkpoint.sqlite", database)
    database.chmod(0o600)
    if (
        digest(database) != manifest["databaseSha256"]
        or digest(base / "checkpoint.sqlite") != manifest["databaseSha256"]
    ):
        raise ValueError("Database changed while copying the checkpoint")
    lineage = {
        "schema": "moon_council_checkpoint_fork_v1",
        "baseSha256": manifest["databaseSha256"],
        "sourceRevision": manifest["sourceRevision"],
        "gameId": manifest["gameId"],
        "baselineUsage": manifest["baselineUsage"],
        "baseEventSequence": manifest["eventSequence"],
    }
    (output / "fork.json").write_text(json.dumps(lineage, indent=2) + "\n")
    return {**lineage, "database": str(database)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    save = commands.add_parser(
        "capture", help="Capture a paused v4 Day 1 database; output must not exist"
    )
    save.add_argument("--db", required=True)
    save.add_argument("--game", required=True)
    save.add_argument("--out", required=True)
    save.add_argument("--source-revision", required=True)
    for name in ["inspect", "fork"]:
        command = commands.add_parser(name)
        command.add_argument("--base", required=True)
        if name == "fork":
            command.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        result = (
            capture(args.db, args.game, args.out, args.source_revision)
            if args.command == "capture"
            else fork(args.base, args.out)
            if args.command == "fork"
            else inspect(args.base)
        )
        print(json.dumps(result, indent=2))
    except (ValueError, OSError, sqlite3.Error, KeyError) as error:
        parser.exit(1, f"checkpoint: {error}\n")


if __name__ == "__main__":
    main()
