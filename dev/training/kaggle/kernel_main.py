"""Kaggle kernel entry: spike or full LoRA training run (see run-config.json)."""
import glob
import json
import os
import subprocess
import sys
import time
from importlib import metadata

INPUT = "/kaggle/input"
WORK = "/kaggle/working"
SCRATCH = "/tmp/agentcp-train"
PACKAGES = ["transformers==5.24.0", "peft", "trl", "accelerate", "bitsandbytes"]
BASE_NAME = "agentcp-qwen35-9b-base-q4"
FT_NAME = "agentcp-qwen35-9b-ft1-q4"

phases = []


def find_data_dir():
    for root, _dirs, files in os.walk(INPUT):
        if "run-config.json" in files:
            return root
    raise SystemExit("run-config.json not found under " + INPUT)


def write_report():
    with open(os.path.join(WORK, "kernel-report.json"), "w", encoding="utf-8") as fh:
        json.dump({"phases": phases}, fh, indent=2)


def run(name, argv, stdout=None):
    start = time.time()
    code = subprocess.run(argv, check=False, stdout=stdout).returncode
    phases.append({"phase": name, "exitCode": code, "durationSeconds": round(time.time() - start, 1)})
    return code


def finish(code):
    write_report()
    sys.exit(code)


def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(SCRATCH, exist_ok=True)
    data = find_data_dir()
    sys.path.insert(0, data)

    with open(os.path.join(WORK, "gpu.txt"), "w", encoding="utf-8") as gpu:
        try:
            run("nvidia-smi", ["nvidia-smi"], stdout=gpu)
        except OSError as err:
            gpu.write("nvidia-smi unavailable: %s\n" % err)
            phases.append({"phase": "nvidia-smi", "exitCode": 127, "durationSeconds": 0})

    # The Kaggle image ships torchao 0.10.0, and peft 0.21 refuses to attach LoRA while an older torchao
    # is installed (spike 1, 2026-11-23). This job does not use torchao, so remove it. A missing package is fine.
    run("pip-uninstall-torchao", [sys.executable, "-m", "pip", "uninstall", "-y", "torchao"])
    code = run("pip-install", [sys.executable, "-m", "pip", "install", *PACKAGES])
    for pkg in ["transformers", "peft", "trl", "accelerate", "bitsandbytes", "torch"]:
        try:
            print(pkg, metadata.version(pkg))
        except metadata.PackageNotFoundError:
            print(pkg, "not installed")
    if code:
        finish(code)

    with open(os.path.join(data, "run-config.json"), encoding="utf-8") as fh:
        cfg = json.load(fh)
    mode = cfg.get("mode")
    train_mode = cfg.get("trainMode")
    if mode not in ("spike", "full") or train_mode not in ("a", "b", "c"):
        print("bad run-config.json: mode=%r trainMode=%r" % (mode, train_mode))
        finish(2)

    train = [sys.executable, os.path.join(data, "train_lora.py"), "--data", data,
             "--out", WORK, "--mode", train_mode, "--max-steps", "20" if mode == "spike" else "0"]
    code = run("train", train)
    if code or mode == "spike":
        finish(code)

    export = os.path.join(data, "export_gguf.py")
    adapter = os.path.join(WORK, "adapter")
    for phase, ad, name in (("export-base", "none", BASE_NAME), ("export-ft", adapter, FT_NAME)):
        code = run(phase, [sys.executable, export, "--adapter", ad, "--name", name,
                           "--scratch", SCRATCH, "--out", WORK])
        if code:
            finish(code)

    # The export writes <name>.Modelfile into WORK; copy any that landed in the data dir unchanged.
    for src in glob.glob(os.path.join(data, "*.Modelfile")):
        dst = os.path.join(WORK, os.path.basename(src))
        if not os.path.exists(dst):
            with open(src, "rb") as fi, open(dst, "wb") as fo:
                fo.write(fi.read())
    finish(0)


if __name__ == "__main__":
    main()
