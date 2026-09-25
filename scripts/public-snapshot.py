#!/usr/bin/env python3
"""Export an allowlisted, source-only snapshot; never publish local Git history or game data.

This is a conservative publication check, not proof that source contains no secrets.
Findings report locations only. Review the resulting source before pushing.
"""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

ROOT_FILES = {
    ".dockerignore",
    ".env.example",
    ".gitignore",
    ".nvmrc",
    "Dockerfile",
    "README.md",
    "package.json",
    "package-lock.json",
    "playwright.config.ts",
    "tsconfig.json",
    "vitest.config.ts",
}
DOCS = {
    "PROTOCOL_V2.md",
    "PROTOCOL_V3.md",
    "JEV_DECISIONS.md",
    "OPENAI_CACHING.md",
    "ACTOR_WORKFLOW.md",
    "ACTOR_EVALUATION.json",
    "ACTOR_HOLDOUT_EVALUATION.json",
}
PATTERNS = {
    "private-key": re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    "openai-key": re.compile(r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}"),
    "github-token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})"),
    "aws-key": re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "credential-assignment": re.compile(
        r"(?i)(?:api[_-]?key|token|password|secret)\s*[:=]\s*[\"\x27]?[A-Za-z0-9_+/=-]{32,}"
    ),
    "personal-network": re.compile(
        r"\b100\.(?:[6-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}\b|\b(?:10\.\d{1,3}|192\.168)\.\d{1,3}\.\d{1,3}\b|\b\w+@\d+\.\d+\.\d+\.\d+"
    ),
    "personal-path": re.compile(r"/(?:root|home|Users)/"),
    "private-host": re.compile(r"[A-Za-z0-9.-]+\.(?:ts\.net|internal)\b"),
}


def native(path):
    raw = Path(path).absolute()
    if raw == Path("/mnt") or Path("/mnt") in raw.parents:
        raise ValueError("Use native Linux paths")
    value = raw.resolve()
    if value == Path("/mnt") or Path("/mnt") in value.parents:
        raise ValueError("Use native Linux paths")
    return value


def allowed(name):
    p = Path(name)
    if p.name.startswith(".env") and name != ".env.example":
        return False
    if p.name.endswith((".orig", ".bak", ".log", ".db", ".sqlite", ".pem", ".key")) or any(
        part in {"node_modules", "dist", "data", "research", ".git", "__pycache__"}
        for part in p.parts
    ):
        return False
    return (
        name in ROOT_FILES
        or name.startswith(("apps/", "packages/", ".github/workflows/"))
        or (name.startswith("scripts/") and p.name != "deploy-pi.sh")
        or (p.parent == Path("docs") and p.name in DOCS)
    )


def findings(text):
    return [
        {"line": i, "rule": rule}
        for i, line in enumerate(text.splitlines(), 1)
        for rule, pattern in PATTERNS.items()
        if pattern.search(line)
    ]


def sanitize(name, data):
    text = data.decode("utf8")
    # Machine-specific source strings belong in local environment configuration.
    # Format: {"private string": "public replacement"}; never commit that configuration.
    replacements = json.loads(os.environ.get("PUBLIC_SNAPSHOT_REPLACEMENTS", "{}"))
    if not isinstance(replacements, dict) or not all(
        isinstance(k, str) and k and isinstance(v, str) for k, v in replacements.items()
    ):
        raise ValueError("PUBLIC_SNAPSHOT_REPLACEMENTS must be a nonempty-string to string mapping")
    for private, public in replacements.items():
        text = text.replace(private, public)
    if name == "apps/web/vite.config.ts":
        text = re.sub(
            r"allowedHosts: \[[^\]]*\],",
            'allowedHosts: process.env.DEV_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? [],',
            text,
        )
    if name == "README.md":
        text = (
            "\n".join(line for line in text.splitlines() if "docs/VERIFICATION_" not in line) + "\n"
        )
    if name in {".gitignore", ".dockerignore"}:
        text += "\n# Runtime and private material are never part of the source distribution.\ndata/\n.env*\n!.env.example\n*.db\n*.db-*\n*.sqlite\n*.log\n*.orig\n*.pem\n*.key\n"
    return text.encode("utf8")


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verify-history",
        action="store_true",
        help="Verify raw public refs and paths, without sanitizing or writing",
    )
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", help="Required except for --verify-history")
    parser.add_argument(
        "--revision", help="Export this tree instead of the working tree; no history is copied"
    )
    parser.add_argument(
        "--scan-only", action="store_true", help="Scan allowlisted source without writing"
    )
    args = parser.parse_args()
    source = native(args.source)
    if args.verify_history:
        errors = []
        commits = git(source, "rev-list", "--all").decode().splitlines()
        for revision in commits:
            for name in filter(
                None,
                git(source, "ls-tree", "-r", "--name-only", "-z", revision).decode().split("\0"),
            ):
                if not allowed(name):
                    errors.append({"revision": revision, "path": name, "rule": "excluded-path"})
                    continue
                text = git(source, "show", f"{revision}:{name}").decode("utf8")
                errors.extend({"revision": revision, "path": name, **f} for f in findings(text))
        print(json.dumps({"commits": len(commits), "findings": errors}, indent=2))
        return int(bool(errors))
    if not args.output:
        parser.error("--output is required for export")
    output = native(args.output)
    if source == output:
        raise ValueError("Output must be a separate source-only directory")
    if Path(git(source, "rev-parse", "--show-toplevel").decode().strip()).resolve() != source:
        raise ValueError("Source must be the repository root")
    names = (
        git(source, "ls-tree", "-r", "--name-only", "-z", args.revision).decode().split("\0")
        if args.revision
        else git(source, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
        .decode()
        .split("\0")
    )
    files = {}
    errors = []
    for name in sorted(set(filter(allowed, filter(None, names)))):
        if args.revision:
            data = git(source, "show", f"{args.revision}:{name}")
        else:
            p = source / name
            if p.is_symlink():
                raise ValueError(f"Symlink requires manual review: {name}")
            if not p.is_file():
                continue
            data = p.read_bytes()
        data = sanitize(name, data)
        errors.extend({"path": name, **finding} for finding in findings(data.decode("utf8")))
        files[name] = data
    if errors:
        print(json.dumps({"files": len(files), "findings": errors}, indent=2))
        return 1
    if not args.scan_only:
        output.mkdir(parents=True, exist_ok=True)
        for name, data in files.items():
            p = output / name
            if p.exists() and p.is_symlink():
                raise ValueError(f"Output symlink: {name}")
            if output not in p.resolve().parents:
                raise ValueError("Output escape")
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
    print(
        json.dumps(
            {
                "files": len(files),
                "findings": [],
                "revision": args.revision,
                "written": not args.scan_only,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
