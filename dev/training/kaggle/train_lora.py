#!/usr/bin/env python3
"""LoRA fine-tune of Qwen/Qwen3.5-9B on a Kaggle notebook (GOALS 23, G23.6).

Usage:
  python train_lora.py --data <dir> --out <dir> --mode <a|b|c> --max-steps <n>

  --data       directory holding train.jsonl and val.jsonl, rows shaped
               {"messages": [{"role": "system"...}, {"role": "user"...}, {"role": "assistant"...}]}
  --out        output directory; receives adapter/ and train-report.json
  --mode       a = fp16 LoRA across all visible GPUs (device_map="auto")
               c = bf16 LoRA across all visible GPUs; bf16 is emulated on a T4 (spike 2 gave NaN in fp16)
               b = nf4 4-bit QLoRA on GPU 0 only (fallback)
  --max-steps  optimizer steps to run; 0 means two full epochs

Loss is computed on the assistant reply only. The prompt part is rendered with
add_generation_prompt=True and its tokens are masked with -100 here, without
relying on a trl feature. Exit code 3 means CUDA out of memory (train-report.json
then holds {"status": "oom", ...}).

The script expects torch, transformers, peft, accelerate (and bitsandbytes for
mode b) to be installed by the caller. It installs and downloads nothing itself
beyond the model weights that from_pretrained fetches.
"""
import argparse
import json
import math
import os
import sys
import time

MODEL_ID = "Qwen/Qwen3.5-9B"
SEED = 20261122
MAX_SEQ_LENGTH = 3072
EPOCHS = 2
LEARNING_RATE = 1e-4
WARMUP_STEPS = 10
BATCH_SIZE = 1
GRAD_ACCUM = 8
LORA_R = 16
LORA_ALPHA = 16
LORA_DROPOUT = 0.0
LORA_LEAVES = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")
OOM_EXIT_CODE = 3
NAN_EXIT_CODE = 4


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="LoRA training for Qwen3.5-9B on Kaggle")
    ap.add_argument("--data", required=True, help="directory with train.jsonl and val.jsonl")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--mode", required=True, choices=["a", "b", "c"], help="a = fp16 LoRA, b = nf4 QLoRA, c = bf16 LoRA")
    ap.add_argument("--max-steps", type=int, default=0, dest="max_steps",
                    help="optimizer steps; 0 means two full epochs")
    return ap.parse_args(argv)


ARGS = parse_args()

# Mode b trains on GPU 0 only. Hide the other GPU before torch loads so the
# Trainer does not wrap the 4-bit model in DataParallel.
if ARGS.mode == "b":
    os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import torch  # noqa: E402
import transformers  # noqa: E402
from torch.utils.data import Dataset  # noqa: E402
from transformers import (  # noqa: E402
    AutoModelForCausalLM,
    AutoTokenizer,
    Trainer,
    TrainerCallback,
    TrainingArguments,
)


def library_versions():
    names = ["torch", "transformers", "peft", "trl", "accelerate", "bitsandbytes", "datasets"]
    out = {"python": sys.version.split()[0]}
    try:
        from importlib import metadata
    except ImportError:  # pragma: no cover
        return out
    for name in names:
        try:
            out[name] = metadata.version(name)
        except Exception:
            out[name] = None
    return out


def gpu_peaks_mib():
    peaks = {}
    if not torch.cuda.is_available():
        return peaks
    for i in range(torch.cuda.device_count()):
        peaks[f"cuda:{i}"] = {
            "peak_allocated_mib": round(torch.cuda.max_memory_allocated(i) / 2**20, 1),
            "peak_reserved_mib": round(torch.cuda.max_memory_reserved(i) / 2**20, 1),
        }
    return peaks


def write_report(out_dir, report):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "train-report.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    return path


def read_jsonl(path):
    if not os.path.isfile(path):
        raise FileNotFoundError(f"missing data file: {path}")
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            msgs = row.get("messages")
            if not isinstance(msgs, list) or len(msgs) < 2 or msgs[-1].get("role") != "assistant":
                raise ValueError(f"{path}:{n}: row must have messages ending with an assistant turn")
            rows.append(msgs)
    return rows


def encode_rows(tokenizer, rows, label):
    """Tokenize rows; mask everything except the final assistant reply with -100.

    Returns (examples, stats). Rows longer than MAX_SEQ_LENGTH are dropped and counted.
    """
    examples = []
    dropped_long = 0
    template_fallback = 0
    for msgs in rows:
        prompt_text = tokenizer.apply_chat_template(
            msgs[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False
        )
        full_text = tokenizer.apply_chat_template(msgs, tokenize=False, enable_thinking=False)
        if full_text.startswith(prompt_text):
            completion_text = full_text[len(prompt_text):]
        else:
            # The template renders the final turn differently from the generation
            # prompt (for example an extra think block). Keep the prompt exactly as
            # the model sees it at inference and append the reply plus end token.
            template_fallback += 1
            completion_text = msgs[-1]["content"] + "<|im_end|>\n"
        prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
        completion_ids = tokenizer(completion_text, add_special_tokens=False)["input_ids"]
        ids = prompt_ids + completion_ids
        if len(ids) > MAX_SEQ_LENGTH:
            dropped_long += 1
            continue
        labels = [-100] * len(prompt_ids) + completion_ids
        examples.append({"input_ids": ids, "labels": labels})
    stats = {
        "rows_in": len(rows),
        "rows_kept": len(examples),
        "rows_dropped_over_max_len": dropped_long,
        "template_prompt_mismatch_rows": template_fallback,
    }
    print(f"[data] {label}: {stats}", flush=True)
    return examples, stats


class ListDataset(Dataset):
    def __init__(self, items):
        self.items = items

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        return self.items[i]


class PadCollator:
    def __init__(self, pad_id):
        self.pad_id = pad_id

    def __call__(self, batch):
        longest = max(len(b["input_ids"]) for b in batch)
        input_ids, labels, mask = [], [], []
        for b in batch:
            pad = longest - len(b["input_ids"])
            input_ids.append(b["input_ids"] + [self.pad_id] * pad)
            labels.append(b["labels"] + [-100] * pad)
            mask.append([1] * len(b["input_ids"]) + [0] * pad)
        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
            "attention_mask": torch.tensor(mask, dtype=torch.long),
        }


class StepTimer(TrainerCallback):
    def __init__(self):
        self.t0 = None
        self.step_seconds = []

    def on_step_begin(self, args, state, control, **kwargs):
        torch.cuda.synchronize() if torch.cuda.is_available() else None
        self.t0 = time.time()

    def on_step_end(self, args, state, control, **kwargs):
        torch.cuda.synchronize() if torch.cuda.is_available() else None
        if self.t0 is not None:
            self.step_seconds.append(time.time() - self.t0)


class NanGuard(TrainerCallback):
    """Stops the run when the logged loss or grad_norm is not finite for several steps in a row.

    Spike 2 on Kaggle (2026-11-23) ran 20 steps with grad_norm nan and loss 0 and still exited 0,
    so a finite check is part of the training result, not only the exit code.
    """

    def __init__(self, patience=3):
        self.patience = patience
        self.bad_in_a_row = 0
        self.tripped = False

    def on_log(self, args, state, control, logs=None, **kwargs):
        if not logs or ("loss" not in logs and "grad_norm" not in logs):
            return
        bad = False
        for key in ("loss", "grad_norm"):
            value = logs.get(key)
            if value is not None and not math.isfinite(float(value)):
                bad = True
        if "loss" in logs and float(logs["loss"]) == 0.0 and state.global_step > 1:
            bad = True
        self.bad_in_a_row = self.bad_in_a_row + 1 if bad else 0
        if self.bad_in_a_row >= self.patience:
            self.tripped = True
            control.should_training_stop = True


def dtype_kwarg(value):
    """transformers 4.56+ renamed torch_dtype to dtype."""
    try:
        major, minor = (int(x) for x in transformers.__version__.split(".")[:2])
    except ValueError:
        major, minor = 5, 0
    if (major, minor) >= (4, 56):
        return {"dtype": value}
    return {"torch_dtype": value}


def load_model(mode):
    if mode in ("a", "c"):
        return AutoModelForCausalLM.from_pretrained(
            MODEL_ID, device_map="auto", **dtype_kwarg(torch.float16 if mode == "a" else torch.bfloat16)
        )
    from transformers import BitsAndBytesConfig

    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.float16,
    )
    return AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        quantization_config=bnb,
        device_map={"": 0},
        **dtype_kwarg(torch.float16),
    )


def select_lora_targets(model):
    """Return (module names, rule). Restrict to names with "language_model" when any exist."""
    candidates = [
        name
        for name, mod in model.named_modules()
        if isinstance(mod, torch.nn.Linear) and name.rsplit(".", 1)[-1] in LORA_LEAVES
    ]
    restricted = [n for n in candidates if "language_model" in n]
    if restricted:
        return restricted, "restricted to modules whose name contains 'language_model'"
    return candidates, "no 'language_model' names exist (text-only class); seven names without restriction"


def main():
    args = ARGS
    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)
    versions = library_versions()
    report = {
        "status": "started",
        "model": MODEL_ID,
        "mode": args.mode,
        "max_steps_arg": args.max_steps,
        "seed": SEED,
        "versions": versions,
    }
    print(f"[env] versions: {versions}", flush=True)
    if not torch.cuda.is_available():
        report.update(status="error", message="CUDA is not available")
        write_report(out_dir, report)
        print("[error] CUDA is not available", flush=True)
        return 1
    print(f"[env] visible GPUs: {torch.cuda.device_count()}", flush=True)

    transformers.set_seed(SEED)
    try:
        tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        if tokenizer.pad_token_id is None:
            tokenizer.pad_token = tokenizer.eos_token

        train_rows = read_jsonl(os.path.join(args.data, "train.jsonl"))
        val_rows = read_jsonl(os.path.join(args.data, "val.jsonl"))
        train_ex, train_stats = encode_rows(tokenizer, train_rows, "train")
        val_ex, val_stats = encode_rows(tokenizer, val_rows, "val")
        if not train_ex or not val_ex:
            raise ValueError("no usable rows after length filtering")
        report["data"] = {"train": train_stats, "val": val_stats}

        model = load_model(args.mode)
        model.config.use_cache = False

        # Freeze every parameter, then attach LoRA.
        for p in model.parameters():
            p.requires_grad = False

        from peft import LoraConfig, get_peft_model

        if args.mode == "b":
            from peft import prepare_model_for_kbit_training

            model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
        else:
            model.enable_input_require_grads()

        targets, rule = select_lora_targets(model)
        print(f"[lora] rule applied: {rule}", flush=True)
        print(f"[lora] number of LoRA modules: {len(targets)}", flush=True)
        if not targets:
            raise ValueError("no LoRA target modules found")
        report["lora"] = {
            "r": LORA_R,
            "alpha": LORA_ALPHA,
            "dropout": LORA_DROPOUT,
            "rule": rule,
            "module_count": len(targets),
        }
        cfg = LoraConfig(
            r=LORA_R,
            lora_alpha=LORA_ALPHA,
            lora_dropout=LORA_DROPOUT,
            bias="none",
            target_modules=targets,
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(model, cfg)
        # Adapter weights in fp32 (the base stays fp16 / nf4).
        for p in model.parameters():
            if p.requires_grad:
                p.data = p.data.float()
        trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
        total = sum(p.numel() for p in model.parameters())
        print(f"[lora] trainable parameters: {trainable} of {total}", flush=True)
        report["lora"]["trainable_parameters"] = trainable

        for i in range(torch.cuda.device_count()):
            torch.cuda.reset_peak_memory_stats(i)

        targs = TrainingArguments(
            output_dir=os.path.join(out_dir, "trainer-state"),
            num_train_epochs=EPOCHS,
            max_steps=args.max_steps if args.max_steps > 0 else -1,
            per_device_train_batch_size=BATCH_SIZE,
            per_device_eval_batch_size=BATCH_SIZE,
            gradient_accumulation_steps=GRAD_ACCUM,
            learning_rate=LEARNING_RATE,
            lr_scheduler_type="cosine",
            warmup_steps=WARMUP_STEPS,
            fp16=args.mode != "c",
            bf16=args.mode == "c",
            gradient_checkpointing=True,
            gradient_checkpointing_kwargs={"use_reentrant": False},
            eval_strategy="epoch",
            save_strategy="no",
            logging_steps=1,
            seed=SEED,
            data_seed=SEED,
            report_to="none",
            remove_unused_columns=False,
            dataloader_pin_memory=False,
        )
        timer = StepTimer()
        guard = NanGuard()
        trainer = Trainer(
            model=model,
            args=targs,
            train_dataset=ListDataset(train_ex),
            eval_dataset=ListDataset(val_ex),
            data_collator=PadCollator(tokenizer.pad_token_id),
            callbacks=[timer, guard],
        )

        t_start = time.time()
        result = trainer.train()
        train_seconds = time.time() - t_start
        if guard.tripped:
            report.update(
                status="nan",
                message="loss or grad_norm was not finite for 3 logged steps in a row; training stopped",
                steps=trainer.state.global_step,
                train_seconds=round(train_seconds, 1),
                gpu_peak_memory_mib=gpu_peaks_mib(),
            )
            write_report(out_dir, report)
            print("[nan] training stopped: loss or grad_norm not finite", flush=True)
            return NAN_EXIT_CODE

        val_losses = [
            {"epoch": h.get("epoch"), "step": h.get("step"), "eval_loss": h["eval_loss"]}
            for h in trainer.state.log_history
            if "eval_loss" in h
        ]
        # A short spike (max-steps > 0) may end before an epoch boundary.
        if args.max_steps > 0 or not val_losses:
            m = trainer.evaluate()
            val_losses.append(
                {"epoch": m.get("epoch"), "step": trainer.state.global_step, "eval_loss": m["eval_loss"]}
            )
        steps = trainer.state.global_step
        step_s = timer.step_seconds
        seconds_per_step = (sum(step_s) / len(step_s)) if step_s else None
        steady = step_s[1:] if len(step_s) > 1 else step_s
        seconds_per_step_excl_first = (sum(steady) / len(steady)) if steady else None
        peaks = gpu_peaks_mib()

        adapter_dir = os.path.join(out_dir, "adapter")
        trainer.model.save_pretrained(adapter_dir)

        report.update(
            status="ok",
            steps=steps,
            train_seconds=round(train_seconds, 1),
            seconds_per_step=seconds_per_step,
            seconds_per_step_excluding_first=seconds_per_step_excl_first,
            train_loss=result.training_loss,
            val_loss=val_losses[-1]["eval_loss"],
            val_losses=val_losses,
            gpu_peak_memory_mib=peaks,
            adapter_dir=adapter_dir,
        )
        for dev, pk in peaks.items():
            print(f"[gpu] {dev} peak allocated MiB: {pk['peak_allocated_mib']} "
                  f"(reserved {pk['peak_reserved_mib']})", flush=True)
        print(f"[train] steps: {steps}", flush=True)
        print(f"[train] seconds per step: {seconds_per_step}", flush=True)
        print(f"[train] train loss: {result.training_loss}", flush=True)
        print(f"[train] validation loss: {val_losses[-1]['eval_loss']} (all: {val_losses})", flush=True)
        path = write_report(out_dir, report)
        print(f"[done] adapter: {adapter_dir}; report: {path}", flush=True)
        return 0
    except torch.cuda.OutOfMemoryError as exc:
        report.update(
            status="oom",
            message=str(exc)[:2000],
            gpu_peak_memory_mib=gpu_peaks_mib(),
        )
        write_report(out_dir, report)
        print(f"[oom] CUDA out of memory: {str(exc)[:500]}", flush=True)
        return OOM_EXIT_CODE


if __name__ == "__main__":
    sys.exit(main())
