"""
difficulty_model.py — Professional Difficulty Classifier
────────────────────────────────────────────────────────────────────
AI Quiz Generator · Difficulty classification module

Purpose
-------
Classifies generated MCQs/questions into: easy, medium, hard.

How it works
------------
1) If trained weights exist, it uses a PyTorch neural classifier head
   on top of frozen 384-dim SentenceTransformer embeddings.
2) If trained weights are missing or fail to load, it falls back to a
   transparent heuristic so the app still works out of the box.

Compatibility
-------------
This file is drop-in compatible with the existing project:
- app.py imports: DifficultyClassifier, load_training_meta
- train_difficulty.py imports: DifficultyNet, LABEL2IDX, LABELS,
  EMBED_DIM, WEIGHTS_PATH, save_training_meta

Environment variables
---------------------
DIFFICULTY_WEIGHTS_PATH   Optional custom path for difficulty_weights.pt
DIFFICULTY_META_PATH      Optional custom path for difficulty_train_meta.json
DIFFICULTY_DEVICE         auto | cpu | cuda  (default: auto)
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union

import torch
import torch.nn as nn

logger = logging.getLogger("DIFFICULTY_MODEL")

# Public constants used by train_difficulty.py
LABELS: List[str] = ["easy", "medium", "hard"]
LABEL2IDX: Dict[str, int] = {label: idx for idx, label in enumerate(LABELS)}
IDX2LABEL: Dict[int, str] = {idx: label for label, idx in LABEL2IDX.items()}

# all-MiniLM-L6-v2 produces 384-dim embeddings.
EMBED_DIM = 384

BASE_DIR = Path(__file__).resolve().parent
WEIGHTS_PATH = os.getenv("DIFFICULTY_WEIGHTS_PATH", str(BASE_DIR / "difficulty_weights.pt"))
META_PATH = os.getenv("DIFFICULTY_META_PATH", str(BASE_DIR / "difficulty_train_meta.json"))

# Heuristic signal lists. These are only used before a fine-tuned model exists.
EASY_CUES = {
    "define", "identify", "name", "list", "state", "what", "who", "when", "where",
    "capital", "symbol", "term", "meaning", "example",
}
MEDIUM_CUES = {
    "explain", "describe", "compare", "differentiate", "summarize", "classify",
    "interpret", "illustrate", "apply", "role", "function", "process", "factors",
}
HARD_CUES = {
    "analyze", "evaluate", "criticize", "critically", "derive", "prove", "synthesize",
    "justify", "assess", "optimize", "formulate", "hypothesize", "trade-offs",
    "limitations", "assumptions", "implications", "complexity", "asymptotic", "regularized",
}
TECHNICAL_TERMS = {
    "algorithm", "architecture", "backpropagation", "regression", "variance", "entropy",
    "gradient", "optimization", "complexity", "classification", "transformer", "embedding",
    "photosynthesis", "mitochondria", "homeostasis", "probability", "derivative",
    "integral", "hypothesis", "neural", "semantic", "computational", "statistical",
}


@dataclass(frozen=True)
class DifficultyPrediction:
    """Detailed prediction object for debugging/UI use."""

    label: str
    confidence: float
    probabilities: Dict[str, float]
    source: str  # "model" or "heuristic"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class DifficultyNet(nn.Module):
    """
    Small feed-forward neural classifier on top of frozen sentence embeddings.

    Kept intentionally compact for CPU-friendly training and inference.
    The layer names/shape are compatible with the project's original
    training script and checkpoint format.
    """

    def __init__(self, embed_dim: int = EMBED_DIM, num_classes: int = 3):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(embed_dim, 128),
            nn.ReLU(),
            nn.Dropout(0.25),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Dropout(0.15),
            nn.Linear(64, num_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def _normalise_text(text: Any) -> str:
    """Return safe, compact text for inference/heuristics."""
    if text is None:
        return ""
    value = str(text)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def _safe_device() -> torch.device:
    """Resolve torch device without crashing on systems without CUDA."""
    requested = os.getenv("DIFFICULTY_DEVICE", "auto").strip().lower()
    if requested == "cuda":
        if torch.cuda.is_available():
            return torch.device("cuda")
        logger.warning("DIFFICULTY_DEVICE=cuda was requested, but CUDA is not available. Using CPU.")
        return torch.device("cpu")
    if requested == "cpu":
        return torch.device("cpu")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _extract_state_dict(raw: Any) -> Mapping[str, torch.Tensor]:
    """
    Accept both old checkpoints and future richer checkpoints.

    Supported formats:
    - raw state_dict: {"net.0.weight": tensor, ...}
    - checkpoint dict: {"state_dict": {...}, "meta": {...}}
    - checkpoint dict: {"model_state_dict": {...}}
    """
    if isinstance(raw, Mapping):
        for key in ("state_dict", "model_state_dict", "model"):
            candidate = raw.get(key)
            if isinstance(candidate, Mapping):
                return candidate  # type: ignore[return-value]
        return raw  # type: ignore[return-value]
    raise TypeError("Unsupported checkpoint format")


def _torch_load(path: Union[str, Path], device: torch.device) -> Any:
    """Load torch checkpoint with best-effort weights_only support."""
    try:
        # Newer PyTorch versions support weights_only for safer loading.
        return torch.load(path, map_location=device, weights_only=True)  # type: ignore[call-arg]
    except TypeError:
        return torch.load(path, map_location=device)


def _softmax_probabilities(logits: torch.Tensor) -> Dict[str, float]:
    probs = torch.softmax(logits, dim=-1).detach().cpu().numpy().reshape(-1)
    return {label: round(float(probs[idx]), 4) for idx, label in IDX2LABEL.items()}


def _label_from_scores(scores: Sequence[float]) -> Tuple[str, float, Dict[str, float]]:
    """Convert heuristic scores to label + confidence + probability-like dict."""
    # Stable softmax for interpretable fallback confidence.
    max_score = max(scores)
    exps = [math.exp(s - max_score) for s in scores]
    total = sum(exps) or 1.0
    probs = [e / total for e in exps]
    idx = int(max(range(len(scores)), key=lambda i: probs[i]))
    return IDX2LABEL[idx], round(float(probs[idx]), 4), {
        IDX2LABEL[i]: round(float(probs[i]), 4) for i in range(len(probs))
    }


class DifficultyClassifier:
    """
    Production-friendly wrapper around DifficultyNet.

    Public methods used by the project:
    - predict(text) -> "easy" | "medium" | "hard"
    - predict_batch(texts) -> list[str]
    - is_trained() -> bool

    Extra methods available for debugging/UI:
    - predict_detail(text) -> DifficultyPrediction
    - predict_batch_detail(texts) -> list[DifficultyPrediction]
    - reload() -> reload weights from disk
    """

    def __init__(
        self,
        embedder: Optional[Any] = None,
        weights_path: Union[str, Path] = WEIGHTS_PATH,
        device: Optional[Union[str, torch.device]] = None,
    ):
        self.embedder = embedder
        self.weights_path = Path(weights_path)
        self.device = torch.device(device) if device is not None else _safe_device()
        self.model: Optional[DifficultyNet] = None
        self.last_error: Optional[str] = None
        self._load_if_available()

    def _load_if_available(self) -> None:
        """Load trained weights if available; otherwise use heuristic fallback."""
        self.model = None
        self.last_error = None

        if not self.weights_path.exists():
            logger.info(
                "ℹ No fine-tuned difficulty_weights.pt found yet — using heuristic fallback. "
                "Run train_difficulty.py with your labeled data to enable the neural classifier."
            )
            return

        try:
            net = DifficultyNet(embed_dim=EMBED_DIM, num_classes=len(LABELS)).to(self.device)
            raw = _torch_load(self.weights_path, self.device)
            state = _extract_state_dict(raw)
            net.load_state_dict(state, strict=True)
            net.eval()
            self.model = net
            logger.info("✓ Loaded fine-tuned difficulty model from %s on %s", self.weights_path, self.device)
        except Exception as exc:  # keep app alive even if checkpoint is corrupt/mismatched
            self.last_error = str(exc)
            self.model = None
            logger.warning("Could not load difficulty weights (%s); using heuristic fallback", exc)

    def reload(self) -> bool:
        """Reload weights from disk. Returns True if neural model is available."""
        self._load_if_available()
        return self.is_trained()

    def _heuristic_detail(self, text: Any) -> DifficultyPrediction:
        """
        Smarter fallback difficulty classifier.

        It is intentionally transparent and deterministic. This is not a
        replacement for training, but it gives reasonable labels before the
        neural classifier is fine-tuned.
        """
        clean = _normalise_text(text)
        if not clean:
            return DifficultyPrediction(
                label="easy",
                confidence=0.90,
                probabilities={"easy": 0.90, "medium": 0.08, "hard": 0.02},
                source="heuristic",
            )

        lower = clean.lower()
        words = re.findall(r"[a-zA-Z][a-zA-Z\-']*", lower)
        word_count = len(words)
        unique_ratio = len(set(words)) / max(word_count, 1)
        avg_word_len = sum(len(w) for w in words) / max(word_count, 1)
        long_word_ratio = sum(1 for w in words if len(w) >= 8) / max(word_count, 1)
        technical_hits = sum(1 for w in words if w in TECHNICAL_TERMS)

        question_starters = set(words[:4])
        easy_hits = len(question_starters & EASY_CUES) + sum(1 for cue in EASY_CUES if cue in lower)
        medium_hits = len(question_starters & MEDIUM_CUES) + sum(1 for cue in MEDIUM_CUES if cue in lower)
        hard_hits = len(question_starters & HARD_CUES) + sum(1 for cue in HARD_CUES if cue in lower)

        # Score all three classes. Tuned for educational MCQ question text.
        easy_score = 1.25
        medium_score = 0.85
        hard_score = 0.55

        # Length and vocabulary complexity.
        if word_count <= 9:
            easy_score += 1.20
        elif word_count <= 20:
            medium_score += 0.95
        else:
            hard_score += min(1.40, (word_count - 20) / 18)

        if avg_word_len < 5.2:
            easy_score += 0.35
        elif avg_word_len < 6.5:
            medium_score += 0.35
        else:
            hard_score += 0.45

        medium_score += min(0.60, long_word_ratio * 1.20)
        hard_score += min(1.10, long_word_ratio * 2.00)
        medium_score += min(0.40, unique_ratio * 0.35)
        hard_score += min(0.70, technical_hits * 0.22)

        # Bloom's taxonomy style cue words.
        easy_score += min(1.00, easy_hits * 0.18)
        medium_score += min(1.25, medium_hits * 0.26)
        hard_score += min(1.60, hard_hits * 0.35)

        # Some specific phrasing reliably indicates harder cognitive load.
        if re.search(r"\b(why|how|under what conditions|to what extent)\b", lower):
            medium_score += 0.35
        if re.search(r"\b(compare and contrast|critically evaluate|derive|prove|assess)\b", lower):
            hard_score += 0.85
        if re.search(r"\b(what is|who is|when did|where is|name the|define)\b", lower):
            easy_score += 0.65

        label, confidence, probabilities = _label_from_scores([easy_score, medium_score, hard_score])
        return DifficultyPrediction(
            label=label,
            confidence=confidence,
            probabilities=probabilities,
            source="heuristic",
        )

    # Backward-compatible alias used internally by older code/tests.
    def _heuristic(self, text: Any) -> str:
        return self._heuristic_detail(text).label

    def _encode(self, texts: Union[str, List[str]]) -> torch.Tensor:
        """Encode text(s) with the provided embedder and return a tensor on self.device."""
        if self.embedder is None:
            raise RuntimeError("No embedder is available")

        # sentence-transformers supports convert_to_numpy; custom wrappers may not.
        try:
            emb = self.embedder.encode(texts, convert_to_numpy=True, show_progress_bar=False)
        except TypeError:
            emb = self.embedder.encode(texts)

        x = torch.as_tensor(emb, dtype=torch.float32, device=self.device)
        if x.ndim == 1:
            x = x.unsqueeze(0)
        if x.shape[-1] != EMBED_DIM:
            raise ValueError(f"Expected embedding dim {EMBED_DIM}, got {x.shape[-1]}")
        return x

    @torch.no_grad()
    def predict_detail(self, text: Any) -> DifficultyPrediction:
        """Return detailed label, confidence and probabilities for one text."""
        clean = _normalise_text(text)
        if self.model is None or self.embedder is None:
            return self._heuristic_detail(clean)

        try:
            x = self._encode(clean)
            logits = self.model(x)
            probabilities = _softmax_probabilities(logits)
            label = max(probabilities, key=probabilities.get)
            return DifficultyPrediction(
                label=label,
                confidence=probabilities[label],
                probabilities=probabilities,
                source="model",
            )
        except Exception as exc:
            self.last_error = str(exc)
            logger.warning("Difficulty model inference failed (%s); using heuristic", exc)
            return self._heuristic_detail(clean)

    @torch.no_grad()
    def predict(self, text: Any) -> str:
        """Return only the class label. Kept for existing app compatibility."""
        return self.predict_detail(text).label

    @torch.no_grad()
    def predict_batch_detail(self, texts: Iterable[Any]) -> List[DifficultyPrediction]:
        """Return detailed predictions for many texts efficiently."""
        clean_texts = [_normalise_text(t) for t in texts]
        if not clean_texts:
            return []

        if self.model is None or self.embedder is None:
            return [self._heuristic_detail(t) for t in clean_texts]

        try:
            x = self._encode(clean_texts)
            logits = self.model(x)
            probs_tensor = torch.softmax(logits, dim=-1).detach().cpu()
            out: List[DifficultyPrediction] = []
            for row in probs_tensor:
                probs = {label: round(float(row[idx]), 4) for idx, label in IDX2LABEL.items()}
                label = max(probs, key=probs.get)
                out.append(DifficultyPrediction(
                    label=label,
                    confidence=probs[label],
                    probabilities=probs,
                    source="model",
                ))
            return out
        except Exception as exc:
            self.last_error = str(exc)
            logger.warning("Batch difficulty inference failed (%s); using heuristic", exc)
            return [self._heuristic_detail(t) for t in clean_texts]

    @torch.no_grad()
    def predict_batch(self, texts: Iterable[Any]) -> List[str]:
        """Return labels for many texts. Kept for existing app compatibility."""
        return [pred.label for pred in self.predict_batch_detail(texts)]

    def is_trained(self) -> bool:
        """True when trained PyTorch weights are loaded successfully."""
        return self.model is not None

    def status(self) -> Dict[str, Any]:
        """Useful for health/debug endpoints."""
        return {
            "trained": self.is_trained(),
            "device": str(self.device),
            "weights_path": str(self.weights_path),
            "weights_exists": self.weights_path.exists(),
            "last_error": self.last_error,
            "labels": LABELS,
            "embed_dim": EMBED_DIM,
        }


def save_training_meta(history: Mapping[str, Any], path: Optional[Union[str, Path]] = None) -> None:
    """
    Persist a JSON sidecar with training run stats.

    Used by /api/v1/ml-info in app.py. Writes atomically to avoid corrupt JSON
    if the process is interrupted mid-write.
    """
    out_path = Path(path or META_PATH)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(history)
    payload.setdefault("labels", LABELS)
    payload.setdefault("embed_dim", EMBED_DIM)
    payload.setdefault("weights_path", str(WEIGHTS_PATH))

    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    try:
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        tmp_path.replace(out_path)
    except Exception as exc:
        logger.warning("Could not write training meta: %s", exc)
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass


def load_training_meta(path: Optional[Union[str, Path]] = None) -> Optional[Dict[str, Any]]:
    """Load training metadata JSON if available."""
    meta_path = Path(path or META_PATH)
    if not meta_path.exists():
        return None
    try:
        with meta_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception as exc:
        logger.warning("Could not read training meta from %s: %s", meta_path, exc)
        return None


def validate_label(label: Any) -> str:
    """Normalize/validate a difficulty label for training scripts or APIs."""
    value = str(label or "").strip().lower()
    if value not in LABEL2IDX:
        raise ValueError(f"Invalid difficulty label {label!r}. Expected one of: {', '.join(LABELS)}")
    return value


__all__ = [
    "DifficultyNet",
    "DifficultyClassifier",
    "DifficultyPrediction",
    "LABELS",
    "LABEL2IDX",
    "IDX2LABEL",
    "EMBED_DIM",
    "WEIGHTS_PATH",
    "META_PATH",
    "save_training_meta",
    "load_training_meta",
    "validate_label",
]
