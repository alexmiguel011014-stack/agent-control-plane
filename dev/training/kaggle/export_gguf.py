#!/usr/bin/env python3
"""Merge an optional LoRA adapter into Qwen/Qwen3.5-9B and export a Q4_K_M GGUF.

Runs on a Kaggle notebook (Linux, CPU merge). Steps: build llama-quantize from
llama.cpp tag v1.0.0, load the base in fp16 on the CPU, merge the adapter when
one is given, save the HF folder, convert to an f16 GGUF without a vision
projector, quantize to Q4_K_M, write the Ollama Modelfile, print size and SHA-256.

Usage:
    python export_gguf.py --adapter <dir|none> --name <model name> \
        --scratch <dir> --out <dir>
"""

import argparse
import glob
import gc
import hashlib
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE_MODEL = "Qwen/Qwen3.5-9B"
LLAMA_CPP_URL = "https://github.com/ggml-org/llama.cpp"
LLAMA_CPP_TAG = "v1.0.0"
QUANT_TYPE = "Q4_K_M"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

MODELFILE_LINES = [
    "FROM ./{file}",
    "RENDERER qwen3.5",
    "PARSER qwen3.5",
    "PARAMETER temperature 1",
    "PARAMETER top_k 20",
    "PARAMETER top_p 0.95",
    "PARAMETER presence_penalty 1.5",
]


def phase(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{stamp}] {message}", flush=True)


def run(cmd, cwd=None) -> None:
    phase("run: " + " ".join(str(part) for part in cmd))
    subprocess.run([str(part) for part in cmd], cwd=cwd, check=True)


def find_quantize(llama_dir: Path):
    for pattern in ("llama-quantize", "llama-quantize.exe"):
        hit = llama_dir / "build" / "bin" / pattern
        if hit.is_file():
            return hit
    matches = glob.glob(str(llama_dir / "build" / "**" / "llama-quantize*"), recursive=True)
    for match in matches:
        path = Path(match)
        if path.is_file() and os.access(path, os.X_OK) and path.suffix in ("", ".exe"):
            return path
    return None


def prepare_llama_cpp(scratch: Path) -> Path:
    llama_dir = scratch / "llama.cpp"
    binary = llama_dir / "build" / "bin" / "llama-quantize"
    if binary.is_file():
        phase(f"llama-quantize already built at {binary}; skipping clone and build")
        return llama_dir
    if not (llama_dir / "convert_hf_to_gguf.py").is_file():
        if llama_dir.exists():
            phase(f"removing incomplete clone {llama_dir}")
            shutil.rmtree(llama_dir)
        phase(f"clone llama.cpp {LLAMA_CPP_TAG}")
        run(["git", "clone", "--depth", "1", "--branch", LLAMA_CPP_TAG, LLAMA_CPP_URL, llama_dir])
    phase("build llama-quantize (CPU only)")
    run(["cmake", "-B", "build", "-DGGML_CUDA=OFF", "-DLLAMA_CURL=OFF"], cwd=llama_dir)
    run(["cmake", "--build", "build", "--target", "llama-quantize", "-j"], cwd=llama_dir)
    if find_quantize(llama_dir) is None:
        raise SystemExit("llama-quantize was not found under build/bin after the build")
    return llama_dir


def merge_and_save(adapter, hf_dir: Path) -> None:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    phase(f"load {BASE_MODEL} in fp16 on the CPU")
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        torch_dtype=torch.float16,
        device_map="cpu",
        low_cpu_mem_usage=True,
    )
    if adapter is not None:
        from peft import PeftModel

        phase(f"merge adapter {adapter}")
        model = PeftModel.from_pretrained(model, str(adapter))
        model = model.merge_and_unload()
        model = model.to(torch.float16)
    else:
        phase("no adapter: exporting the base weights unchanged")

    phase(f"save merged model and tokenizer to {hf_dir}")
    hf_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(hf_dir), safe_serialization=True, max_shard_size="4GB")
    AutoTokenizer.from_pretrained(BASE_MODEL).save_pretrained(str(hf_dir))
    del model
    gc.collect()


def convert_to_f16_gguf(llama_dir: Path, hf_dir: Path, f16_path: Path) -> None:
    # Do not install llama.cpp's requirements file: it pins older transformers/torch versions, and the
    # second export in the same session must still load Qwen3.5 with transformers 5.24.0. The converter
    # loads gguf-py from the clone; only these two small packages are added.
    phase("install the converter's extra packages (sentencepiece, protobuf)")
    run([sys.executable, "-m", "pip", "install", "sentencepiece", "protobuf"])
    phase("convert to f16 GGUF (no vision projector)")
    run(
        [
            sys.executable,
            "convert_hf_to_gguf.py",
            hf_dir,
            "--outtype",
            "f16",
            "--outfile",
            f16_path,
        ],
        cwd=llama_dir,
    )


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(16 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--adapter", required=True, help="LoRA adapter directory, or 'none'")
    parser.add_argument("--name", required=True, help="model name, used for the output file names")
    parser.add_argument("--scratch", required=True, help="scratch directory for large files")
    parser.add_argument("--out", required=True, help="output directory for the GGUF and Modelfile")
    args = parser.parse_args()

    if not NAME_RE.match(args.name):
        raise SystemExit(f"invalid --name {args.name!r}: use letters, digits, '.', '_' and '-'")

    adapter = None
    if args.adapter.lower() != "none":
        adapter = Path(args.adapter).resolve()
        if not adapter.is_dir():
            raise SystemExit(f"--adapter {args.adapter!r} is not a directory (use 'none' for no adapter)")

    scratch = Path(args.scratch).resolve()
    out_dir = Path(args.out).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    hf_dir = scratch / f"{args.name}-hf"
    f16_path = scratch / f"{args.name}-f16.gguf"
    gguf_path = out_dir / f"{args.name}.gguf"
    modelfile_path = out_dir / f"{args.name}.Modelfile"

    phase(f"export start: name={args.name} adapter={adapter if adapter else 'none'}")
    llama_dir = prepare_llama_cpp(scratch)
    quantize = find_quantize(llama_dir)
    if quantize is None:
        raise SystemExit("llama-quantize was not found under build/bin")

    merge_and_save(adapter, hf_dir)
    convert_to_f16_gguf(llama_dir, hf_dir, f16_path)

    phase(f"quantize to {QUANT_TYPE}")
    run([quantize, f16_path, gguf_path, QUANT_TYPE])

    phase("delete the f16 GGUF and the merged folder")
    f16_path.unlink(missing_ok=True)
    shutil.rmtree(hf_dir, ignore_errors=True)

    phase(f"write {modelfile_path}")
    modelfile_path.write_text(
        "\n".join(line.format(file=gguf_path.name) for line in MODELFILE_LINES) + "\n",
        encoding="utf-8",
    )

    size = gguf_path.stat().st_size
    phase("hash the GGUF")
    digest = sha256_of(gguf_path)
    phase(f"done: {gguf_path.name} size={size} bytes ({size / 1024 ** 3:.2f} GiB) sha256={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
