#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Derived from HenryQW/skills; modified for exact backup identity, retention, and regressions.
# See ../../../NOTICE.md for the source snapshot and modification notices.
"""Update current non-main worktree branch from fetched origin/main."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from unittest import mock

MAIN_SOURCE_REF = "refs/heads/main"
FETCHED_MAIN_REF = "refs/remotes/origin/main"
MAIN_BRANCH_REF = "refs/heads/main"
IN_PROGRESS_PATHS = (
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
)


class UpdateError(RuntimeError):
    pass


def run(args: list[str], *, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if check and result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise UpdateError(detail or f"git {' '.join(args)} failed")
    return result


def git(args: list[str], *, cwd: Path | None = None) -> str:
    return run(args, cwd=cwd).stdout.strip()


def revision(ref: str) -> str:
    return git(["rev-parse", "--verify", f"{ref}^{{commit}}"])


def current_branch_ref() -> str:
    result = run(["symbolic-ref", "--quiet", "HEAD"], check=False)
    if result.returncode:
        raise UpdateError("HEAD must name a local branch")
    ref = result.stdout.strip()
    if ref == MAIN_BRANCH_REF:
        raise UpdateError("refusing to update main from itself")
    if not ref.startswith("refs/heads/"):
        raise UpdateError(f"HEAD must name refs/heads/*, got {ref}")
    return ref


def has_git_path(name: str) -> bool:
    return Path(git(["rev-parse", "--git-path", name])).exists()


def active_operation() -> str | None:
    return next((name for name in IN_PROGRESS_PATHS if has_git_path(name)), None)


def unmerged_paths() -> list[str]:
    output = run(["diff", "--name-only", "--diff-filter=U", "-z"]).stdout
    return output.removesuffix("\0").split("\0") if output else []


def status_lines() -> list[str]:
    return git(["status", "--porcelain=v1", "--untracked-files=all"]).splitlines()


def ignored_source_paths(source_sha: str) -> list[str]:
    root = Path(git(["rev-parse", "--show-toplevel"]))
    ignored = run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], cwd=root).stdout.removesuffix("\0").split("\0")
    source = run(["ls-tree", "-r", "--full-tree", "--name-only", "-z", source_sha], cwd=root).stdout.removesuffix("\0").split("\0")
    return sorted(path for path in ignored if path and any(
        path == tracked or path.startswith(tracked + "/") or tracked.startswith(path + "/")
        for tracked in source if tracked
    ))


def require_ready_worktree() -> str:
    if git(["rev-parse", "--is-inside-work-tree"]) != "true":
        raise UpdateError("current directory must be inside a worktree")
    operation = active_operation()
    if operation:
        raise UpdateError(f"Git operation already active: {operation}")
    if unmerged_paths():
        raise UpdateError("worktree has unresolved conflicts")
    branch = current_branch_ref()
    if any(re.search(r": update-from-main(?: [0-9a-f-]{36})?$", line)
           for line in git(["stash", "list", "--format=%gs"]).splitlines()):
        raise UpdateError("update-from-main backup remains retained; finish its recovery before another run")
    return branch


def stash_dirty_worktree(source_sha: str) -> str | None:
    ignored = ignored_source_paths(source_sha)
    if not status_lines() and not ignored:
        return None
    message = f"update-from-main {uuid.uuid4()}"
    mode = "--all" if ignored else "--include-untracked"
    run(["stash", "push", mode, "--message", message])
    # Linked worktrees share the stash stack. Find this run's entry, not its mutable tip.
    entries = git(["stash", "list", "--format=%H%x00%gs"]).splitlines()
    matches = [line.split("\0", 1)[0] for line in entries if line.endswith(f": {message}")]
    if len(matches) != 1:
        raise UpdateError(f"could not identify backup with message {message}; inspect the stash reflog before retrying")
    return matches[0]


def fetch_source() -> str:
    # Porcelain reports the OID this fetch observed, even if another fetch moves the tracking ref.
    args = ["fetch", "--verbose", "--porcelain", "--no-tags", "--no-write-fetch-head", "origin", f"+{MAIN_SOURCE_REF}:{FETCHED_MAIN_REF}"]
    result = run(args, check=False)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        race = re.search(
            rf"cannot lock ref '{re.escape(FETCHED_MAIN_REF)}': "
            r"is at [0-9a-f]+ but expected [0-9a-f]+\b",
            detail,
        )
        if not race:
            raise UpdateError(detail or "git fetch failed")
        time.sleep(0.2)
        result = run(args)
    matches = [re.fullmatch(r"[ *+=] [0-9a-f]+ ([0-9a-f]{40}|[0-9a-f]{64}) " + re.escape(FETCHED_MAIN_REF), line)
               for line in result.stdout.splitlines()]
    captured = [match.group(1) for match in matches if match]
    if len(captured) != 1:
        raise UpdateError("git fetch returned invalid origin/main evidence")
    oid = captured[0]
    return oid


def is_ancestor(ancestor: str, descendant: str) -> bool:
    result = run(["merge-base", "--is-ancestor", ancestor, descendant], check=False)
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    detail = (result.stderr or result.stdout).strip()
    raise UpdateError(detail or "git merge-base failed")


def restore_stash(stash_oid: str) -> tuple[bool, str, str]:
    result = run(["stash", "apply", "--index", stash_oid], check=False)
    detail = (result.stderr or result.stdout).strip().replace("\n", " | ")
    return result.returncode == 0, "retained", detail


def emit(
    status: str,
    branch_ref: str,
    head_before: str,
    main_sha: str,
    stash_oid: str | None,
    stash_state: str,
    conflict_paths: list[str] | None = None,
) -> None:
    stash = "none" if stash_oid is None else f"{stash_oid}:{stash_state}"
    fields = [
        ("status", status),
        ("branch", branch_ref),
        ("before", head_before),
        ("main", f"{FETCHED_MAIN_REF}:{main_sha}"),
        ("head", revision("HEAD")),
        ("stash", stash),
    ]
    if conflict_paths:
        fields.append(("conflicts", str(len(conflict_paths))))
    print(" ".join(f"{key}={value}" for key, value in fields))
    if conflict_paths:
        print(f"conflict_paths={json.dumps(conflict_paths, separators=(',', ':'))}")


def update_from_main() -> int:
    stash_oid: str | None = None
    main_sha = "none"
    try:
        branch_ref = require_ready_worktree()
        head_before = revision("HEAD")
        main_sha = fetch_source()
        stash_oid = stash_dirty_worktree(main_sha)
        if status_lines():
            raise UpdateError(f"stash {stash_oid} did not clean worktree")
        if current_branch_ref() != branch_ref or revision(branch_ref) != head_before:
            raise UpdateError("current branch moved before merge")
        if is_ancestor(main_sha, "HEAD"):
            outcome = "up_to_date"
        else:
            result = run(["merge", "--ff", "--no-edit", main_sha], check=False)
            if result.returncode:
                detail = (result.stderr or result.stdout).strip().replace("\n", " | ")
                conflicts = unmerged_paths()
                if conflicts:
                    emit(
                        "merge_conflict",
                        branch_ref,
                        head_before,
                        main_sha,
                        stash_oid,
                        "retained",
                        conflicts,
                    )
                    print(f"error: {detail}", file=sys.stderr)
                    return 2
                if has_git_path("MERGE_HEAD"):
                    emit("merge_pending", branch_ref, head_before, main_sha, stash_oid, "retained")
                    print(
                        f"error: {detail}; fix hook failure, run GIT_EDITOR=true git merge --continue, "
                        "then apply non-none stash OID",
                        file=sys.stderr,
                    )
                    return 2
                raise UpdateError(detail or "git merge failed")
            outcome = "merged"

        if outcome == "merged" and status_lines():
            emit("submodule_update_required", branch_ref, head_before, main_sha, stash_oid, "retained")
            print(
                "error: initialized submodule requires git submodule update --checkout --recursive; "
                "then apply non-none stash OID",
                file=sys.stderr,
            )
            return 4

        if stash_oid:
            restored, stash_state, detail = restore_stash(stash_oid)
            if not restored:
                conflicts = unmerged_paths()
                status = "stash_conflict" if conflicts else "stash_restore_failed"
                emit(
                    status,
                    branch_ref,
                    head_before,
                    main_sha,
                    stash_oid,
                    "retained",
                    conflicts,
                )
                print(f"error: {detail}", file=sys.stderr)
                return 3
        else:
            stash_state = "none"
        emit(outcome, branch_ref, head_before, main_sha, stash_oid, stash_state)
        return 0
    except UpdateError as error:
        if stash_oid and not active_operation():
            restored, stash_state, detail = restore_stash(stash_oid)
            if not restored:
                error = UpdateError(f"{error}; stash backup retained at {stash_oid}: {detail}")
            elif stash_state == "retained":
                error = UpdateError(f"{error}; stash restored but retained at {stash_oid}")
        elif stash_oid:
            error = UpdateError(f"{error}; stash backup retained at {stash_oid}")
        print(f"error: {error}", file=sys.stderr)
        return 1


def test_git(path: Path, *args: str) -> str:
    return git(list(args), cwd=path)


def setup_repo(root: Path) -> tuple[Path, Path]:
    root.mkdir()
    origin = root / "origin.git"
    seed = root / "seed"
    repo = root / "repo"
    run(["init", "--bare", os.fspath(origin)])
    run(["init", os.fspath(seed)])
    test_git(seed, "checkout", "-b", "main")
    test_git(seed, "config", "user.email", "agent@example.invalid")
    test_git(seed, "config", "user.name", "Agent")
    (seed / "shared.txt").write_text("base\n", encoding="utf-8")
    (seed / "conflict.txt").write_text("base\n", encoding="utf-8")
    test_git(seed, "add", ".")
    test_git(seed, "commit", "-m", "init")
    test_git(seed, "remote", "add", "origin", os.fspath(origin))
    test_git(seed, "push", "-u", "origin", "main")
    run(["--git-dir", os.fspath(origin), "symbolic-ref", "HEAD", MAIN_BRANCH_REF])
    run(["clone", os.fspath(origin), os.fspath(repo)])
    test_git(repo, "config", "user.email", "agent@example.invalid")
    test_git(repo, "config", "user.name", "Agent")
    test_git(repo, "checkout", "-b", "feature")
    return seed, repo


def commit(path: Path, name: str, value: str, message: str) -> str:
    (path / name).write_text(value, encoding="utf-8")
    test_git(path, "add", name)
    test_git(path, "commit", "-m", message)
    return test_git(path, "rev-parse", "HEAD")


def update_in(path: Path) -> tuple[int, str]:
    previous = Path.cwd()
    output = io.StringIO()
    try:
        os.chdir(path)
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            return update_from_main(), output.getvalue()
    finally:
        os.chdir(previous)


def self_test() -> None:
    lock_race = subprocess.CompletedProcess(
        ["git"],
        1,
        "",
        f"error: cannot lock ref '{FETCHED_MAIN_REF}': is at abc but expected def",
    )
    oid = "a" * 40
    success = subprocess.CompletedProcess(["git"], 0, f"= {oid} {oid} {FETCHED_MAIN_REF}\n", "")
    fetch_args = ["fetch", "--verbose", "--porcelain", "--no-tags", "--no-write-fetch-head", "origin", f"+{MAIN_SOURCE_REF}:{FETCHED_MAIN_REF}"]
    with mock.patch(__name__ + ".run", side_effect=(lock_race, success)) as mocked_run:
        with mock.patch(__name__ + ".time.sleep") as mocked_sleep:
            assert fetch_source() == oid
            assert mocked_run.call_args_list == [
                mock.call(fetch_args, check=False),
                mock.call(fetch_args),
            ]
            mocked_sleep.assert_called_once_with(0.2)

    non_races = (
        "error: network down",
        f"error: cannot lock ref '{FETCHED_MAIN_REF}': expected symref but is a regular ref",
    )
    for detail in non_races:
        failure = subprocess.CompletedProcess(["git"], 1, "", detail)
        with mock.patch(__name__ + ".run", return_value=failure) as mocked_run:
            try:
                fetch_source()
            except UpdateError as error:
                assert str(error) == detail
            else:
                raise AssertionError("non-race fetch failure did not fail fast")
            assert mocked_run.call_count == 1

    with tempfile.TemporaryDirectory() as raw_tmp:
        root = Path(raw_tmp)
        seed, repo = setup_repo(root / "clean")
        head_before = commit(repo, "feature.txt", "feature\n", "test: feature")
        main_sha = commit(seed, "main.txt", "main\n", "test: main")
        test_git(seed, "push", "origin", "main")
        (repo / "staged.txt").write_text("staged\n", encoding="utf-8")
        test_git(repo, "add", "staged.txt")
        (repo / "untracked.txt").write_text("untracked\n", encoding="utf-8")
        result, output = update_in(repo)
        assert result == 0
        assert len(output.split()) == 6
        assert "branch=refs/heads/feature" in output
        assert f"before={head_before}" in output
        assert f"main={FETCHED_MAIN_REF}:{main_sha}" in output
        assert f"head={test_git(repo, 'rev-parse', 'HEAD')}" in output
        stash_oid = test_git(repo, "rev-parse", "refs/stash")
        assert f"stash={stash_oid}:retained" in output
        assert test_git(repo, "rev-parse", FETCHED_MAIN_REF) == main_sha
        assert (repo / "main.txt").read_text(encoding="utf-8") == "main\n"
        assert "A  staged.txt" in test_git(repo, "status", "--porcelain=v1", "--untracked-files=all")
        assert (repo / "untracked.txt").read_text(encoding="utf-8") == "untracked\n"
        assert update_in(repo)[0] == 1  # Even a restored backup needs explicit user removal.
        assert test_git(repo, "rev-parse", "refs/stash") == stash_oid

        for phase in ("capture", "restore"):
            seed, repo = setup_repo(root / f"stash-race-{phase}")
            main_sha = commit(seed, "main.txt", "main\n", "test: main")
            test_git(seed, "push", "origin", "main")
            peer = root / f"peer-{phase}"
            test_git(repo, "worktree", "add", "--detach", os.fspath(peer), "HEAD")
            (repo / "shared.txt").write_text("staged\n", encoding="utf-8")
            test_git(repo, "add", "shared.txt")
            (repo / "shared.txt").write_text("unstaged\n", encoding="utf-8")
            (repo / "local.txt").write_bytes(b"local\x00bytes\n")
            (peer / "peer.txt").write_text("peer backup\n", encoding="utf-8")
            real_run = run
            peer_oid = None

            def push_peer_stash(args, **kwargs):
                nonlocal peer_oid
                if phase == "restore" and args[:2] in (["stash", "apply"], ["stash", "pop"]):
                    real_run(["stash", "push", "--include-untracked", "-m", "peer backup"], cwd=peer)
                    peer_oid = test_git(peer, "rev-parse", "refs/stash")
                result = real_run(args, **kwargs)
                if phase == "capture" and args[:2] == ["stash", "push"]:
                    real_run(["stash", "push", "--include-untracked", "-m", "peer backup"], cwd=peer)
                    peer_oid = test_git(peer, "rev-parse", "refs/stash")
                return result

            with mock.patch(__name__ + ".run", side_effect=push_peer_stash):
                result, output = update_in(repo)
            assert result == 0, output
            own_oid = re.search(r"stash=([0-9a-f]+):retained", output).group(1)
            assert own_oid != peer_oid and f"main={FETCHED_MAIN_REF}:{main_sha}" in output
            assert test_git(repo, "show", ":shared.txt") == "staged"
            assert (repo / "shared.txt").read_text(encoding="utf-8") == "unstaged\n"
            assert (repo / "local.txt").read_bytes() == b"local\x00bytes\n"
            assert test_git(peer, "rev-parse", "refs/stash") == peer_oid
            assert test_git(peer, "show", f"{peer_oid}^3:peer.txt") == "peer backup"
            assert len(test_git(repo, "stash", "list").splitlines()) == 2
            assert update_in(repo)[0] == 1

        _seed, repo = setup_repo(root / "legacy-backup")
        (repo / "legacy.txt").write_text("legacy\n", encoding="utf-8")
        test_git(repo, "stash", "push", "--include-untracked", "-m", "update-from-main")
        legacy_oid = test_git(repo, "rev-parse", "refs/stash")
        assert update_in(repo)[0] == 1
        assert test_git(repo, "rev-parse", "refs/stash") == legacy_oid

        seed, repo = setup_repo(root / "conflict")
        commit(repo, "conflict.txt", "feature\n", "test: feature")
        main_sha = commit(seed, "conflict.txt", "main\n", "test: main")
        test_git(seed, "push", "origin", "main")
        (repo / "deferred.txt").write_text("deferred\n", encoding="utf-8")
        result, output = update_in(repo)
        assert result == 2
        stash_oid = test_git(repo, "rev-parse", "refs/stash")
        assert "status=merge_conflict" in output
        assert f"main={FETCHED_MAIN_REF}:{main_sha}" in output
        assert f"stash={stash_oid}:retained conflicts=1" in output
        assert 'conflict_paths=["conflict.txt"]' in output.splitlines()
        assert not (repo / "deferred.txt").exists()
        assert test_git(repo, "diff", "--name-only", "--diff-filter=U") == "conflict.txt"
        assert test_git(repo, "rev-parse", FETCHED_MAIN_REF) == main_sha
        # Recovery merges the captured source, even after the upstream branch advances.
        commit(seed, "later.txt", "later\n", "test: later main")
        test_git(seed, "push", "origin", "main")
        (repo / "conflict.txt").write_text("resolved\n", encoding="utf-8")
        test_git(repo, "add", "conflict.txt")
        test_git(repo, "-c", "core.editor=true", "merge", "--continue")
        test_git(repo, "stash", "apply", "--index", stash_oid)
        assert (repo / "deferred.txt").read_text(encoding="utf-8") == "deferred\n"
        assert not (repo / "later.txt").exists()
        test_git(repo, "merge-base", "--is-ancestor", main_sha, "HEAD")
        assert update_in(repo)[0] == 1  # A retained backup blocks a second merge run.
        assert test_git(repo, "rev-parse", "refs/stash") == stash_oid

        seed, repo = setup_repo(root / "ignored")
        main_sha = commit(seed, "ignored.txt", "upstream\n", "test: main")
        test_git(seed, "push", "origin", "main")
        exclude = repo / ".git" / "info" / "exclude"
        exclude.write_text(exclude.read_text(encoding="utf-8") + "\n/ignored.txt\n", encoding="utf-8")
        (repo / "ignored.txt").write_text("local\n", encoding="utf-8")
        (repo / "sub").mkdir()
        result, output = update_in(repo / "sub")
        stash_oid = test_git(repo, "rev-parse", "refs/stash")
        assert result == 3
        assert "status=stash_restore_failed" in output
        assert f"main={FETCHED_MAIN_REF}:{main_sha}" in output
        assert f"stash={stash_oid}:retained" in output
        assert (repo / "ignored.txt").read_text(encoding="utf-8") == "upstream\n"
        assert test_git(repo, "stash", "show", "--include-untracked", "--name-only", stash_oid) == "ignored.txt"

        seed, repo = setup_repo(root / "untracked-collision")
        main_sha = commit(seed, "new.txt", "upstream\n", "test: main collision")
        test_git(seed, "push", "origin", "main")
        (repo / "new.txt").write_text("local\n", encoding="utf-8")
        result, output = update_in(repo)
        assert result == 3 and "status=stash_restore_failed" in output
        stash_oid = test_git(repo, "rev-parse", "refs/stash")
        assert f"main={FETCHED_MAIN_REF}:{main_sha}" in output
        assert f"stash={stash_oid}:retained" in output
        assert test_git(repo, "show", f"{stash_oid}^3:new.txt") == "local"
        assert (repo / "new.txt").read_text(encoding="utf-8") == "upstream\n"
        assert update_in(repo)[0] == 1
        assert test_git(repo, "rev-parse", "refs/stash") == stash_oid

        seed, repo = setup_repo(root / "fetch-failure")
        (repo / "shared.txt").write_text("staged\n", encoding="utf-8")
        test_git(repo, "add", "shared.txt")
        (repo / "untracked.txt").write_text("local\n", encoding="utf-8")
        before_status = test_git(repo, "status", "--porcelain=v1")
        before_head = test_git(repo, "rev-parse", "HEAD")
        test_git(repo, "remote", "set-url", "origin", os.fspath(root / "absent.git"))
        assert update_in(repo)[0] == 1
        assert test_git(repo, "status", "--porcelain=v1") == before_status
        assert test_git(repo, "rev-parse", "HEAD") == before_head
        assert not test_git(repo, "stash", "list")

        seed, repo = setup_repo(root / "captured-fetch")
        main_sha = commit(seed, "captured.txt", "captured\n", "test: captured main")
        test_git(seed, "push", "origin", "main")
        later = commit(seed, "later.txt", "later\n", "test: later main")
        test_git(repo, "fetch", os.fspath(seed), later)
        real_run = run

        def moving_tracking_ref(args, **kwargs):
            result = real_run(args, **kwargs)
            if args[:2] == ["fetch", "--verbose"]:
                real_run(["update-ref", FETCHED_MAIN_REF, later], cwd=repo)
            return result

        with mock.patch(__name__ + ".run", side_effect=moving_tracking_ref):
            result, output = update_in(repo)
        assert result == 0 and f"main={FETCHED_MAIN_REF}:{main_sha}" in output
        assert test_git(repo, "rev-parse", "HEAD") == main_sha
        assert test_git(repo, "rev-parse", FETCHED_MAIN_REF) == later
        assert not (repo / "later.txt").exists()
        assert update_in(repo)[0] == 0  # Up-to-date, with no retained backup.
        test_git(repo, "checkout", "main")
        assert update_in(repo)[0] == 1
        test_git(repo, "checkout", "--detach", "feature")
        assert update_in(repo)[0] == 1

        seed, repo = setup_repo(root / "ignored-newline")
        name = "ignored\nname.txt"
        main_sha = commit(seed, name, "upstream\n", "test: newline collision")
        test_git(seed, "push", "origin", "main")
        (repo / ".git" / "info" / "exclude").write_text("*.txt\n", encoding="utf-8")
        (repo / name).write_text("local\n", encoding="utf-8")
        result, output = update_in(repo)
        assert result == 3 and "status=stash_restore_failed" in output
        stash_oid = test_git(repo, "rev-parse", "refs/stash")
        assert test_git(repo, "show", f"{stash_oid}^3:{name}") == "local"
        assert (repo / name).read_text(encoding="utf-8") == "upstream\n"

        seed, repo = setup_repo(root / "stash-conflict")
        name = "stash conflict.txt"
        commit(seed, name, "base\n", "test: add stash conflict fixture")
        test_git(seed, "push", "origin", "main")
        test_git(repo, "fetch", "origin", "main")
        test_git(repo, "merge", "--ff-only", "origin/main")
        main_sha = commit(seed, name, "main\n", "test: main")
        test_git(seed, "push", "origin", "main")
        (repo / name).write_text("local\n", encoding="utf-8")
        result, output = update_in(repo)
        stash_oid = test_git(repo, "rev-parse", "refs/stash")
        assert result == 3
        assert "status=stash_conflict" in output
        assert f"main={FETCHED_MAIN_REF}:{main_sha}" in output
        assert f"stash={stash_oid}:retained conflicts=1" in output
        assert f'conflict_paths=["{name}"]' in output.splitlines()
        assert run(["diff", "--name-only", "--diff-filter=U", "-z"], cwd=repo).stdout == f"{name}\0"

        child = root / "submodule-child"
        run(["init", os.fspath(child)])
        test_git(child, "config", "user.email", "agent@example.invalid")
        test_git(child, "config", "user.name", "Agent")
        commit(child, "child.txt", "base\n", "test: child")
        _seed, repo = setup_repo(root / "submodule")
        test_git(repo, "-c", "protocol.file.allow=always", "submodule", "add", os.fspath(child), "sub")
        test_git(repo, "commit", "-am", "test: add submodule")
        (repo / "ordinary.txt").write_text("ordinary\n", encoding="utf-8")
        (repo / "sub" / "child.txt").write_text("dirty\n", encoding="utf-8")
        result, _output = update_in(repo)
        assert result == 1
        assert (repo / "ordinary.txt").read_text(encoding="utf-8") == "ordinary\n"
        assert (repo / "sub" / "child.txt").read_text(encoding="utf-8") == "dirty\n"
        assert test_git(repo, "stash", "list")  # Error-path restoration also retains its backup.

        seed, repo = setup_repo(root / "submodule-update")
        child = root / "submodule-update-child"
        run(["init", os.fspath(child)])
        test_git(child, "config", "user.email", "agent@example.invalid")
        test_git(child, "config", "user.name", "Agent")
        child_base = commit(child, "child.txt", "base\n", "test: child")
        test_git(seed, "-c", "protocol.file.allow=always", "submodule", "add", os.fspath(child), "sub")
        test_git(seed, "commit", "-am", "test: add submodule")
        test_git(seed, "push", "origin", "main")
        test_git(repo, "fetch", "origin", "main")
        test_git(repo, "merge", "--ff-only", "origin/main")
        run(["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--checkout"], cwd=repo)
        assert test_git(repo / "sub", "rev-parse", "HEAD") == child_base
        commit(repo, "feature.txt", "feature\n", "test: feature")
        child_sha = commit(child, "child.txt", "main\n", "test: child update")
        test_git(seed / "sub", "fetch", "origin")
        test_git(seed / "sub", "checkout", child_sha)
        test_git(seed, "add", "sub")
        test_git(seed, "commit", "-m", "test: update submodule")
        main_sha = test_git(seed, "rev-parse", "HEAD")
        test_git(seed, "push", "origin", "main")
        (repo / "deferred.txt").write_text("deferred\n", encoding="utf-8")
        result, output = update_in(repo)
        assert result == 4
        stash_oid = test_git(repo, "rev-parse", "refs/stash")
        assert "status=submodule_update_required" in output
        assert f"main={FETCHED_MAIN_REF}:{main_sha}" in output
        assert f"stash={stash_oid}:retained" in output
        assert not (repo / "deferred.txt").exists()
        assert test_git(repo / "sub", "rev-parse", "HEAD") == child_base
        assert "M sub" in test_git(repo, "status", "--porcelain=v1")
        test_git(repo, "-c", "protocol.file.allow=always", "submodule", "update", "--checkout", "--recursive")
        assert test_git(repo / "sub", "rev-parse", "HEAD") == child_sha
        test_git(repo, "stash", "apply", "--index", stash_oid)
        assert (repo / "deferred.txt").read_text(encoding="utf-8") == "deferred\n"

        seed, repo = setup_repo(root / "merge-hook")
        commit(repo, "feature.txt", "feature\n", "test: feature")
        main_sha = commit(seed, "main.txt", "main\n", "test: main")
        test_git(seed, "push", "origin", "main")
        (repo / "deferred.txt").write_text("deferred\n", encoding="utf-8")
        hook = repo / ".git" / "hooks" / "pre-merge-commit"
        hook.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        hook.chmod(0o755)
        result, output = update_in(repo)
        assert result == 2
        stash_oid = test_git(repo, "rev-parse", "refs/stash")
        assert "status=merge_pending" in output
        assert f"main={FETCHED_MAIN_REF}:{main_sha}" in output
        assert f"stash={stash_oid}:retained" in output
        assert (repo / ".git" / "MERGE_HEAD").exists()
        assert not (repo / "deferred.txt").exists()
        hook.unlink()
        run(["-c", "core.editor=true", "merge", "--continue"], cwd=repo)
        test_git(repo, "stash", "apply", "--index", stash_oid)
        assert (repo / "deferred.txt").read_text(encoding="utf-8") == "deferred\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="Run internal checks and exit")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        print("update-from-main self-test ok: update and recovery paths")
        return 0
    return update_from_main()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
