#!/usr/bin/env python3
"""Kaggle notebook runner for the offload batch (stdlib only).

Locates every bundle (manifest.json), records GPU info, installs Ollama and
Node, creates local GGUF models, pulls missing ones, and runs each bundle. Paths under /kaggle are
unverified until the G22.12 smoke test.
"""
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

NODE_URL = "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz"
OLLAMA_HOST = "127.0.0.1:11434"
VERSION_URL = "http://" + OLLAMA_HOST + "/api/version"
KAGGLE = os.path.isdir("/kaggle/working")
WORK = "/kaggle/working" if KAGGLE else os.getcwd()
# Big scratch files stay out of /kaggle/working, because `kaggle kernels output` downloads that folder.
SCRATCH = "/tmp/agentcp-offload" if KAGGLE else os.path.join(WORK, "scratch")


def find_bundles():
    """Return every directory under the search root that holds manifest.json, sorted by path."""
    root = (sys.argv[1:2] or ["/kaggle/input"])[0]
    found = []
    for dirpath, dirs, files in os.walk(root):
        if "manifest.json" in files:
            found.append(dirpath)
            dirs[:] = []  # do not look inside a bundle
    return sorted(found)


def find_modelfiles(root="/kaggle/input"):
    found = []
    for dirpath, _dirs, files in os.walk(root):
        found.extend(os.path.join(dirpath, name) for name in files if name.endswith(".Modelfile"))
    return sorted(found)


def has_model(tag, env):
    """True when `ollama list` already shows the tag (a bare name means :latest)."""
    listing = subprocess.run(["ollama", "list"], env=env, capture_output=True, text=True, check=False)
    want = tag if ":" in tag else tag + ":latest"
    for line in listing.stdout.splitlines()[1:]:
        parts = line.split()
        if parts and (parts[0] == tag or parts[0] == want):
            return True
    return False


def warm_up(tag, rounds=2):
    """Load the model and run a few warm-up requests before the timed bundle run.

    The first kernel run after a cold load took about 110 s on the T4 (G22.12, first attempt), which
    used up the adapter's 120 s limit. These requests use the same num_ctx as the adapter, so the
    model is not reloaded. Their answers are discarded.
    """
    prompt = "Reply with the word ok. " + ("The quick brown fox jumps over the lazy dog. " * 40)
    body = json.dumps({
        "model": tag,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "think": False,
        "options": {"num_ctx": 4096, "num_predict": 8, "temperature": 0},
        "keep_alive": "30m",
    }).encode("utf-8")
    for index in range(rounds):
        started = time.time()
        request = urllib.request.Request(
            "http://" + OLLAMA_HOST + "/api/chat", data=body,
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=900) as response:
                response.read()
            print("warm-up %d done in %.1f s" % (index + 1, time.time() - started), flush=True)
        except OSError as error:
            print("warm-up %d failed: %s" % (index + 1, error), file=sys.stderr, flush=True)


def main():
    bundles = find_bundles()
    if not bundles:
        print("no manifest.json found", file=sys.stderr)
        return 1

    with open(os.path.join(WORK, "gpu.txt"), "w") as fh:
        subprocess.run(["nvidia-smi"], stdout=fh, stderr=subprocess.STDOUT, check=False)

    os.makedirs(SCRATCH, exist_ok=True)
    # The Ollama installer unpacks a .tar.zst archive; install zstd first if it is missing (best effort).
    if shutil.which("zstd") is None:
        subprocess.run(["apt-get", "install", "-y", "zstd"], check=False)
    # The single documented shell pipe: the official Ollama installer.
    subprocess.run("curl -fsSL https://ollama.com/install.sh | sh", shell=True, check=True)

    node_dir = os.path.join(SCRATCH, "node")
    os.makedirs(node_dir, exist_ok=True)
    tar_path = os.path.join(node_dir, "node.tar.xz")
    urllib.request.urlretrieve(NODE_URL, tar_path)
    with tarfile.open(tar_path, "r:xz") as tf:
        tf.extractall(node_dir)
    node_bin = os.path.join(node_dir, "node-v24.18.0-linux-x64", "bin", "node")

    env = dict(os.environ, OLLAMA_HOST=OLLAMA_HOST)
    server = subprocess.Popen(["ollama", "serve"], env=env)
    try:
        deadline = time.time() + 60
        ready = False
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(VERSION_URL, timeout=2):
                    ready = True
                    break
            except OSError:
                time.sleep(1)
        if not ready:
            print("ollama did not become ready within 60 s", file=sys.stderr)
            return 1

        # Local GGUF models: the Modelfile's `FROM ./<file>.gguf` is relative, so run from its folder.
        for modelfile in find_modelfiles():
            name = os.path.basename(modelfile)[:-len(".Modelfile")]
            subprocess.run(["ollama", "create", name, "-f", modelfile],
                           cwd=os.path.dirname(modelfile), env=env, check=True)

        out_dir = os.path.join(WORK, "output") if not KAGGLE else WORK
        os.makedirs(out_dir, exist_ok=True)
        exit_code = 0
        for bundle in bundles:
            with open(os.path.join(bundle, "manifest.json"), encoding="utf-8") as fh:
                manifest = json.load(fh)
            tag = manifest["modelTag"]
            bundle_id = manifest["bundleId"]
            if not has_model(tag, env):
                subprocess.run(["ollama", "pull", tag], env=env, check=True)
            warm_up(tag)

            local = os.path.join(SCRATCH, "bundles", bundle_id)
            if os.path.exists(local):
                shutil.rmtree(local)
            shutil.copytree(bundle, local)
            # `kaggle datasets create --dir-mode zip` stores code/ as code.zip; unpack it if Kaggle did not.
            code_dir = os.path.join(local, "code")
            code_zip = os.path.join(local, "code.zip")
            if not os.path.isdir(code_dir) and os.path.isfile(code_zip):
                with zipfile.ZipFile(code_zip) as zf:
                    zf.extractall(code_dir)
            result_path = os.path.join(out_dir, "results-%s.jsonl" % bundle_id)
            result = subprocess.run(
                [node_bin, "code/dev/offload/run-bundle.ts", local, result_path],
                cwd=local, env=env, check=False)
            exit_code = max(exit_code, result.returncode)
            if len(bundles) == 1 and os.path.isfile(result_path):
                shutil.copyfile(result_path, os.path.join(out_dir, "results.jsonl"))
        return exit_code
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(main())
