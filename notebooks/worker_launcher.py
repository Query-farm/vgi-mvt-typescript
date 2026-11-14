"""Fetch and run the unchanged public Bun worker at one immutable Git revision."""

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory

REVISION = "b1d8396c360d6db194ab45abf1749c5938143e89"
REPOSITORY = "https://github.com/Query-farm/vgi-mvt-typescript.git"


def run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, stdout=sys.stderr)


def main():
    directory = Path(__file__).resolve().parent / "artifacts"
    directory.mkdir(exist_ok=True)
    source = directory / f"worker-{REVISION}"
    lock = directory / f"worker-{REVISION}.lock"
    if subprocess.check_output(["bun", "--version"], text=True).strip() != "1.3.14":
        raise RuntimeError("This example requires Bun 1.3.14; see README.md")
    deadline = time.monotonic() + 180
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            if time.monotonic() > deadline:
                raise RuntimeError(f"Cache lock timed out: {lock}; see README.md") from None
            time.sleep(0.1)
    try:
        if not source.exists():
            with TemporaryDirectory(prefix="install-", dir=directory) as temporary:
                stage = Path(temporary) / "source"
                run("git", "clone", "--no-checkout", REPOSITORY, str(stage))
                run("git", "checkout", "--detach", REVISION, cwd=stage)
                run("bun", "install", "--frozen-lockfile", cwd=stage)
                (stage / ".notebook-installed").write_text(REVISION)
                stage.replace(source)
        if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip() != REVISION:
            raise RuntimeError("Cached Git revision changed; remove the worker cache")
        run("git", "diff", "--quiet", "HEAD", "--", "src", "package.json", "bun.lock", cwd=source)
        if (source / ".notebook-installed").read_text() != REVISION:
            raise RuntimeError("Incomplete cache; remove it and retry")
    finally:
        lock.rmdir()
    bun = shutil.which("bun")
    os.execv(bun, [bun, "run", str(source / "src/worker.ts"), *sys.argv[1:]])


if __name__ == "__main__":
    main()
