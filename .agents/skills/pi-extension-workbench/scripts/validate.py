#!/usr/bin/env python3
"""Exercise authority resolution through direct and shimmed Node launchers."""

import json
import os
from pathlib import Path
import subprocess
import tempfile

RESOLVER = Path(__file__).with_name("resolve-authority.sh")


def check(case: str, diagnostic: str | None = None) -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        package = root / "package root"
        cli = package / "dist" / "cli.js"
        cli.parent.mkdir(parents=True)
        cli.write_text('#!/usr/bin/env node\nconsole.log("1.0.0");\n')
        cli.chmod(0o755)
        name = "wrong-package" if case == "wrong identity" else "@earendil-works/pi-coding-agent"
        (package / "package.json").write_text(json.dumps({"name": name}))
        if case != "missing examples":
            (package / "examples" / "extensions").mkdir(parents=True)
        (package / "docs").mkdir()
        if case != "missing docs":
            (package / "docs" / "extensions.md").touch()
        bin_dir = root / "bin"
        bin_dir.mkdir()
        launcher = bin_dir / "pi"
        if case == "shim":
            launcher.write_text(
                '#!/usr/bin/env node\nrequire("node:child_process").spawnSync('
                f'process.execPath, [{json.dumps(str(cli))}, ...process.argv.slice(2)], '
                '{stdio: "inherit", env: process.env});\n'
            )
            launcher.chmod(0o755)
        elif case in {"non-Node", "failed launcher"}:
            launcher.write_text("#!/bin/sh\n" + ("exit 7\n" if case == "failed launcher" else "echo 1.0.0\n"))
            launcher.chmod(0o755)
        else:
            launcher.symlink_to(cli)
        result = subprocess.run(
            ["bash", str(RESOLVER)], capture_output=True, text=True, timeout=10,
            env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "NODE_OPTIONS": ""},
        )
        if diagnostic:
            assert result.returncode != 0 and not result.stdout, (case, result)
            assert diagnostic in result.stderr, (case, result.stderr)
        else:
            assert result.returncode == 0, (case, result.stderr)
            assert result.stdout == f"{package.resolve()}\n" and not result.stderr, (case, result)


if __name__ == "__main__":
    check("direct")
    check("shim")
    check("wrong identity", "no @earendil-works/pi-coding-agent package")
    check("missing examples", "missing examples/extensions")
    check("missing docs", "missing docs/extensions.md")
    check("non-Node", "no Node entry point")
    check("failed launcher", "launcher failed")
    print("pi-extension-workbench: 7 resolver regressions passed")
