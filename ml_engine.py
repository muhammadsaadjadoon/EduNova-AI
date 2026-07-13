"""
ml_engine.py — AI Quiz Generator Core Engine v9 Professional
────────────────────────────────────────────────────────────────────
Production-friendly MCQ generation pipeline.

Public API kept compatible with the existing project:
    split_sentences, get_pos_tags, extract_noun_phrases,
    get_key_noun_phrase, get_wordnet_distractors,
    EmbeddingModel, QuestionGenerator, QualityScorer,
    DeepQuizEngine, get_engine

Main upgrades over v8:
    • Offline/local-model support through models/ folder and env vars
    • Safer NLTK handling when internet is unavailable
    • Better answer-span filtering and phrase normalization
    • More reliable T5 loading order: fine-tuned → local pretrained → HF → template
    • Device-aware T5 inference (CPU/CUDA)
    • Cleaner distractor validation to avoid duplicates/weird options
    • Improved quality scoring using token/string similarity instead of character sets
    • Better error messages for deployment and offline mode
────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import difflib
import logging
import os
import random
import re
import string as string_punct_module
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

from sklearn.cluster import KMeans
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.preprocessing import normalize

import nltk
from nltk.corpus import stopwords, wordnet
from nltk.tag import pos_tag
from nltk.tokenize import sent_tokenize, word_tokenize

logger = logging.getLogger("ML_ENGINE")

PROJECT_DIR = Path(__file__).resolve().parent
MODELS_DIR = PROJECT_DIR / "models"


def _truthy(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass(frozen=True)
class EngineConfig:
    """Central config so local, offline and Render deployment stay easy."""

    offline: bool = _truthy(os.getenv("QG_OFFLINE")) or _truthy(os.getenv("HF_HUB_OFFLINE")) or _truthy(os.getenv("TRANSFORMERS_OFFLINE"))
    seed: int = int(os.getenv("QG_RANDOM_SEED", "42"))
    max_input_chars: int = int(os.getenv("QG_MAX_INPUT_CHARS", "120000"))
    max_sentences: int = int(os.getenv("QG_MAX_SENTENCES", "450"))
    min_sentence_words: int = int(os.getenv("QG_MIN_SENTENCE_WORDS", "6"))
    max_answer_words: int = int(os.getenv("QG_MAX_ANSWER_WORDS", "5"))
    topic_clusters: int = int(os.getenv("QG_TOPIC_CLUSTERS", "6"))

    embedding_model_name: str = os.getenv("QG_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    embedding_local_path: str = os.getenv("QG_EMBEDDING_LOCAL_PATH", str(MODELS_DIR / "all-MiniLM-L6-v2"))

    finetuned_qg_path: str = os.getenv("QG_FINETUNED_MODEL_PATH", str(PROJECT_DIR / "t5_qg_finetuned"))
    qg_local_path: str = os.getenv("QG_PRETRAINED_LOCAL_PATH", str(MODELS_DIR / "t5-small-qg-hl"))
    qg_hf_name: str = os.getenv("QG_PRETRAINED_HF_NAME", "valhalla/t5-small-qg-hl")
    t5_fallback_local_path: str = os.getenv("QG_T5_FALLBACK_LOCAL_PATH", str(MODELS_DIR / "t5-small"))
    t5_fallback_hf_name: str = os.getenv("QG_T5_FALLBACK_HF_NAME", "t5-small")

    device: str = os.getenv("QG_DEVICE", "auto")


CONFIG = EngineConfig()
random.seed(CONFIG.seed)
np.random.seed(CONFIG.seed)

# Make Hugging Face libraries obey project offline mode before they are imported.
if CONFIG.offline:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_DATASETS_OFFLINE", "1")


# ────────────────────────────────────────────────────────────────
# NLTK setup
# ────────────────────────────────────────────────────────────────
_NLTK_PACKAGES = {
    "punkt": "tokenizers/punkt",
    "punkt_tab": "tokenizers/punkt_tab",
    "stopwords": "corpora/stopwords",
    "wordnet": "corpora/wordnet",
    "omw-1.4": "corpora/omw-1.4",
    "averaged_perceptron_tagger": "taggers/averaged_perceptron_tagger",
    "averaged_perceptron_tagger_eng": "taggers/averaged_perceptron_tagger_eng",
}


def _ensure_nltk_package(pkg: str, resource_path: str) -> None:
    try:
        nltk.data.find(resource_path)
        return
    except LookupError:
        pass

    if CONFIG.offline:
        logger.debug("NLTK package %s is missing, but offline mode is enabled; using fallbacks where possible", pkg)
        return

    try:
        nltk.download(pkg, quiet=True)
    except Exception as exc:
        logger.debug("Could not download NLTK package %s: %s", pkg, exc)


for _pkg, _resource in _NLTK_PACKAGES.items():
    _ensure_nltk_package(_pkg, _resource)

_FALLBACK_STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he", "in", "is", "it", "its",
    "of", "on", "or", "that", "the", "to", "was", "were", "will", "with", "this", "these", "those", "which",
    "also", "however", "therefore", "moreover", "furthermore", "thus", "hence", "consequently", "meanwhile",
    "nevertheless", "because", "while", "during", "through", "between", "among", "into", "over", "under",
}

try:
    STOP_WORDS = set(stopwords.words("english")) | _FALLBACK_STOP_WORDS
except Exception:
    STOP_WORDS = set(_FALLBACK_STOP_WORDS)


# ────────────────────────────────────────────────────────────────
# Text utilities
# ────────────────────────────────────────────────────────────────
def _clean_text(text: str) -> str:
    text = str(text or "")[: CONFIG.max_input_chars]
    text = text.replace("\u00a0", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _normalize_key(text: str) -> str:
    text = text.lower().strip()
    text = text.translate(str.maketrans("", "", string_punct_module.punctuation))
    text = re.sub(r"\s+", " ", text)
    return text


def _tokenize_words(text: str) -> List[str]:
    return re.findall(r"[A-Za-z][A-Za-z0-9_\-]*", text)


def _looks_like_clean_answer(phrase: str) -> bool:
    phrase = phrase.strip(" \t\n\r,.!?;:()[]{}\"'")
    if not phrase or len(phrase) < 3:
        return False
    words = phrase.split()
    if len(words) > CONFIG.max_answer_words:
        return False
    lower_words = [_normalize_key(w) for w in words]
    if all(w in STOP_WORDS for w in lower_words):
        return False
    alpha = sum(ch.isalpha() for ch in phrase)
    if alpha < 3 or alpha / max(len(phrase), 1) < 0.65:
        return False
    if phrase.lower() in {"example", "thing", "things", "something", "someone", "people", "person"}:
        return False

    # Reject font-decoding garbage and random-looking identifiers often produced
    # by badly encoded PDFs. Keep normal technical acronyms such as AI, CPU, CNN.
    for word in words:
        clean = re.sub(r"[^A-Za-z]", "", word)
        if not clean:
            continue
        if len(clean) >= 4 and not re.search(r"[aeiouAEIOU]", clean) and not clean.isupper():
            return False
        transitions = sum(a.islower() != b.islower() for a, b in zip(clean, clean[1:]))
        if len(clean) >= 5 and transitions >= 3 and not clean.isupper():
            return False
        if re.search(r"[A-Za-z]\d[A-Za-z]|\d[A-Za-z]\d", word):
            return False
    return True


def _answer_pattern(answer_span: str) -> str:
    # Avoid \b issues with hyphens/symbols by using non-word boundaries.
    return r"(?<!\w)" + re.escape(answer_span) + r"(?!\w)"


def split_sentences(text: str) -> List[str]:
    """Split source text into clean candidate sentences."""
    text = _clean_text(text)
    if not text:
        return []

    try:
        sents = sent_tokenize(text)
    except Exception:
        sents = re.split(r"(?<=[.!?])\s+", text)

    cleaned: List[str] = []
    seen = set()
    for sent in sents:
        sent = re.sub(r"\s+", " ", sent).strip(" \t\n\r")
        if len(sent) < 20:
            continue
        if len(sent.split()) < CONFIG.min_sentence_words:
            continue
        key = _normalize_key(sent)
        if key and key not in seen:
            cleaned.append(sent)
            seen.add(key)
        if len(cleaned) >= CONFIG.max_sentences:
            break
    return cleaned


def get_pos_tags(sentence: str) -> List[Tuple[str, str]]:
    try:
        return pos_tag(word_tokenize(sentence))
    except Exception:
        # Fallback: treat meaningful capitalized/long words as nouns.
        tokens = _tokenize_words(sentence)
        return [(tok, "NNP" if tok[:1].isupper() else "NN") for tok in tokens]


def extract_noun_phrases(sentence: str) -> List[Tuple[str, str]]:
    """
    Extract candidate answer spans as clean noun phrases.
    Returns (phrase, representative_pos_tag), best candidates first.
    """
    tagged = get_pos_tags(sentence)
    if not tagged:
        return []

    candidates: List[Tuple[str, str, float]] = []
    current_words: List[str] = []
    current_tags: List[str] = []

    def flush() -> None:
        nonlocal current_words, current_tags
        if not current_words:
            return
        phrase = " ".join(current_words).strip(" \t\n\r,.!?;:()[]{}\"'")
        words = phrase.split()
        if _looks_like_clean_answer(phrase):
            has_proper = any(t in {"NNP", "NNPS"} for t in current_tags)
            has_number = any(any(ch.isdigit() for ch in w) for w in words)
            multi = len(words) > 1
            all_caps = any(len(w) > 1 and w.isupper() for w in words)
            technical = any(ch in phrase for ch in "-/+_") or has_number or all_caps

            weight = 1.0
            weight += 2.5 if multi else 0.0
            weight += 2.0 if has_proper else 0.0
            weight += 1.5 if technical else 0.0
            weight += min(len(phrase) / 25.0, 1.0)
            if len(words) == 1 and _normalize_key(words[0]) in STOP_WORDS:
                weight -= 3.0
            candidates.append((phrase, current_tags[-1] if current_tags else "NN", weight))
        current_words = []
        current_tags = []

    noun_tags = {"NN", "NNS", "NNP", "NNPS", "FW"}
    allowed_inside = noun_tags | {"JJ", "JJR", "JJS", "CD"}

    for word, tag in tagged:
        clean_word = word.strip(" \t\n\r,.!?;:()[]{}\"'")
        if not clean_word:
            flush()
            continue
        token_ok = bool(re.match(r"^[A-Za-z][A-Za-z0-9_\-/+]*$", clean_word))
        if not token_ok:
            flush()
            continue

        if tag in noun_tags or (tag in allowed_inside and current_words):
            current_words.append(clean_word)
            current_tags.append(tag)
        else:
            flush()
    flush()

    # Fallback for NLTK POS failures: grab capitalized terms and important long words.
    if not candidates:
        for token in _tokenize_words(sentence):
            if len(token) >= 5 and _normalize_key(token) not in STOP_WORDS:
                tag = "NNP" if token[:1].isupper() else "NN"
                weight = 2.5 if tag == "NNP" else 1.0
                candidates.append((token, tag, weight))

    best_by_key: Dict[str, Tuple[str, str, float]] = {}
    for phrase, tag, weight in candidates:
        key = _normalize_key(phrase)
        if not key or key in STOP_WORDS:
            continue
        if key not in best_by_key or weight > best_by_key[key][2]:
            best_by_key[key] = (phrase, tag, weight)

    ranked = sorted(best_by_key.values(), key=lambda item: (item[2], len(item[0])), reverse=True)
    return [(phrase, tag) for phrase, tag, _weight in ranked]


def get_key_noun_phrase(sentence: str) -> Optional[Tuple[str, str]]:
    phrases = extract_noun_phrases(sentence)
    return phrases[0] if phrases else None


def get_wordnet_distractors(word: str, pos_tag_str: str, n: int = 4) -> List[str]:
    """WordNet distractors for simple, non-technical, single-word answers."""
    if " " in word or not word.isalpha() or len(word) < 4:
        return []
    if CONFIG.offline:
        # WordNet may or may not exist locally; try, but do not download.
        pass

    wn_pos = wordnet.NOUN
    if pos_tag_str.startswith("VB"):
        wn_pos = wordnet.VERB
    elif pos_tag_str.startswith("JJ"):
        wn_pos = wordnet.ADJ

    try:
        synsets = wordnet.synsets(word.lower(), pos=wn_pos)
    except Exception:
        return []
    if not synsets:
        return []

    candidates = set()
    for syn in synsets[:2]:
        for hyper in syn.hypernyms()[:2]:
            for hypo in hyper.hyponyms()[:10]:
                if hypo == syn:
                    continue
                for lemma in hypo.lemmas()[:3]:
                    name = lemma.name().replace("_", " ").strip()
                    if name and _is_valid_distractor(name, word):
                        candidates.add(name)

    out = list(candidates)
    random.shuffle(out)
    return out[:n]


# ────────────────────────────────────────────────────────────────
# Model path helpers
# ────────────────────────────────────────────────────────────────
def _existing_dir(path: str | Path) -> Optional[str]:
    p = Path(path)
    return str(p) if p.is_dir() else None


def _choose_torch_device() -> str:
    if CONFIG.device and CONFIG.device.lower() != "auto":
        return CONFIG.device
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


# ════════════════════════════════════════════════════════════════
# EMBEDDING MODEL
# ════════════════════════════════════════════════════════════════
class EmbeddingModel:
    _instance: Optional["EmbeddingModel"] = None

    def __init__(self):
        self.model = None
        self.model_id = None
        self._load()

    def _candidate_model_ids(self) -> List[str]:
        candidates: List[str] = []
        local = _existing_dir(CONFIG.embedding_local_path)
        if local:
            candidates.append(local)
        if not CONFIG.offline:
            candidates.append(CONFIG.embedding_model_name)
            # Older sentence-transformers accepts short alias too.
            if CONFIG.embedding_model_name != "all-MiniLM-L6-v2":
                candidates.append("all-MiniLM-L6-v2")
        return candidates

    def _load(self) -> None:
        try:
            from sentence_transformers import SentenceTransformer
        except Exception as exc:
            logger.error("✗ sentence-transformers package is not installed or failed to import: %s", exc)
            self.model = None
            return

        candidates = self._candidate_model_ids()
        if not candidates:
            logger.error(
                "✗ Embedding model missing. Offline mode is enabled and local path does not exist: %s",
                CONFIG.embedding_local_path,
            )
            self.model = None
            return

        last_error: Optional[Exception] = None
        for model_id in candidates:
            try:
                kwargs = {"local_files_only": True} if CONFIG.offline or Path(model_id).is_dir() else {}
                logger.info("⏳ Loading sentence-transformer '%s'%s…", model_id, " (local only)" if kwargs else "")
                self.model = SentenceTransformer(model_id, **kwargs)
                self.model_id = model_id
                logger.info("✓ Sentence embedding model ready | model=%s | dim=384", model_id)
                return
            except Exception as exc:
                last_error = exc
                logger.warning("Embedding model load failed for %s: %s", model_id, exc)

        logger.error("✗ Could not load any embedding model. Last error: %s", last_error)
        self.model = None

    @classmethod
    def get(cls) -> "EmbeddingModel":
        if cls._instance is None:
            cls._instance = EmbeddingModel()
        return cls._instance

    def encode(self, texts, show_progress_bar: bool = False) -> np.ndarray:
        if self.model is None:
            raise RuntimeError(
                "Embedding model failed to load. Run download_models_once.py once with internet, "
                "or set QG_EMBEDDING_LOCAL_PATH to a valid local sentence-transformer folder."
            )
        if isinstance(texts, str):
            return np.asarray(self.model.encode([texts], show_progress_bar=show_progress_bar), dtype=np.float32)[0]
        if not texts:
            return np.empty((0, 384), dtype=np.float32)
        return np.asarray(self.model.encode(list(texts), show_progress_bar=show_progress_bar), dtype=np.float32)

    def available(self) -> bool:
        return self.model is not None


# ════════════════════════════════════════════════════════════════
# QUESTION GENERATOR
# ════════════════════════════════════════════════════════════════
class QuestionGenerator:
    _instance: Optional["QuestionGenerator"] = None

    def __init__(self):
        self.tokenizer = None
        self.model = None
        self.mode = "template"  # "qg-hl" | "t5-prompt" | "template"
        self.model_id = None
        self.device = _choose_torch_device()
        self._load()

    def _load_one(self, model_id: str, mode: str, local_only: bool):
        from transformers import T5ForConditionalGeneration, T5TokenizerFast

        kwargs = {"local_files_only": True} if local_only else {}
        logger.info("⏳ Loading T5 model '%s'%s…", model_id, " (local only)" if local_only else "")
        tokenizer = T5TokenizerFast.from_pretrained(model_id, **kwargs)
        model = T5ForConditionalGeneration.from_pretrained(model_id, **kwargs)
        model.to(self.device)
        model.eval()
        self.tokenizer = tokenizer
        self.model = model
        self.mode = mode
        self.model_id = model_id
        logger.info("✓ Question generator ready | model=%s | mode=%s | device=%s", model_id, mode, self.device)

    def _load(self) -> None:
        try:
            import transformers  # noqa: F401
        except Exception as exc:
            logger.error("✗ transformers package is not installed or failed to import: %s", exc)
            self.mode = "template"
            return

        candidates: List[Tuple[str, str, bool]] = []
        fine_tuned = _existing_dir(CONFIG.finetuned_qg_path)
        if fine_tuned:
            candidates.append((fine_tuned, "qg-hl", True))

        local_qg = _existing_dir(CONFIG.qg_local_path)
        if local_qg:
            candidates.append((local_qg, "qg-hl", True))

        local_fallback = _existing_dir(CONFIG.t5_fallback_local_path)
        if local_fallback:
            candidates.append((local_fallback, "t5-prompt", True))

        if not CONFIG.offline:
            candidates.append((CONFIG.qg_hf_name, "qg-hl", False))
            candidates.append((CONFIG.t5_fallback_hf_name, "t5-prompt", False))

        if not candidates:
            logger.warning(
                "No local T5 model found and offline mode is enabled. Using fill-blank template mode. "
                "Expected paths: %s or %s",
                CONFIG.finetuned_qg_path,
                CONFIG.qg_local_path,
            )
            self.mode = "template"
            return

        last_error: Optional[Exception] = None
        for model_id, mode, local_only in candidates:
            try:
                self._load_one(model_id, mode, local_only or CONFIG.offline)
                return
            except Exception as exc:
                last_error = exc
                logger.warning("T5 load failed for %s: %s", model_id, exc)

        logger.error("✗ No transformer question generator could be loaded. Using template fallback. Last error: %s", last_error)
        self.tokenizer = None
        self.model = None
        self.mode = "template"

    @classmethod
    def get(cls) -> "QuestionGenerator":
        if cls._instance is None:
            cls._instance = QuestionGenerator()
        return cls._instance

    def available(self) -> bool:
        return self.mode in {"qg-hl", "t5-prompt"} and self.model is not None and self.tokenizer is not None

    def generate(self, sentence: str, answer_span: str) -> Tuple[Optional[str], bool]:
        question: Optional[str] = None
        if self.available() and self.mode == "qg-hl":
            question = self._generate_qg_hl(sentence, answer_span)
        elif self.available() and self.mode == "t5-prompt":
            question = self._generate_t5_prompt(sentence, answer_span)

        if question and self._is_valid_question(question, sentence, answer_span):
            return question, True
        return self._generate_template(sentence, answer_span), False

    @staticmethod
    def _is_valid_question(question: str, sentence: str, answer_span: str) -> bool:
        q = (question or "").strip()
        words = q.split()
        if len(words) < 4 or len(words) > 45:
            return False
        if not q.endswith("?"):
            return False
        lower_words = [w.lower().strip(string_punct_module.punctuation) for w in words if w.strip(string_punct_module.punctuation)]
        if lower_words and len(set(lower_words)) / max(len(lower_words), 1) < 0.55:
            return False
        if _normalize_key(answer_span) and _normalize_key(answer_span) in _normalize_key(q):
            return False
        source_ratio = difflib.SequenceMatcher(None, _normalize_key(q), _normalize_key(sentence)).ratio()
        if source_ratio > 0.82:
            return False
        return True

    def _run_t5(self, input_text: str, max_input_length: int = 384, max_output_length: int = 72) -> Optional[str]:
        try:
            import torch

            inputs = self.tokenizer(input_text, return_tensors="pt", truncation=True, max_length=max_input_length)
            inputs = {k: v.to(self.device) for k, v in inputs.items()}
            with torch.no_grad():
                outputs = self.model.generate(
                    **inputs,
                    max_length=max_output_length,
                    num_beams=4,
                    early_stopping=True,
                    no_repeat_ngram_size=3,
                    repetition_penalty=1.25,
                    length_penalty=1.0,
                )
            return self._clean_question(self.tokenizer.decode(outputs[0], skip_special_tokens=True).strip())
        except Exception as exc:
            logger.debug("T5 generation failed: %s", exc)
            return None

    def _generate_qg_hl(self, sentence: str, answer_span: str) -> Optional[str]:
        pattern = _answer_pattern(answer_span)
        highlighted = re.sub(pattern, f"<hl> {answer_span} <hl>", sentence, count=1, flags=re.IGNORECASE)
        if "<hl>" not in highlighted:
            highlighted = f"<hl> {answer_span} <hl> {sentence}"
        return self._run_t5(f"generate question: {highlighted}")

    def _generate_t5_prompt(self, sentence: str, answer_span: str) -> Optional[str]:
        return self._run_t5(f"generate question for answer {answer_span}: context: {sentence}")

    def _generate_template(self, sentence: str, answer_span: str) -> Optional[str]:
        pattern = _answer_pattern(answer_span)
        blanked = re.sub(pattern, "______", sentence, count=1, flags=re.IGNORECASE)
        if "______" not in blanked:
            return None
        return blanked.strip()

    @staticmethod
    def _clean_question(q: str) -> str:
        q = re.sub(r"\s+", " ", (q or "")).strip()
        if not q:
            return q
        q = q[0].upper() + q[1:]
        if not q.endswith("?"):
            q = q.rstrip(" .") + "?"
        return q


# ════════════════════════════════════════════════════════════════
# DISTRACTOR VALIDATION + QUALITY SCORING
# ════════════════════════════════════════════════════════════════
def _token_set(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in STOP_WORDS}


def _is_valid_distractor(candidate: str, answer: str) -> bool:
    candidate = candidate.strip(" \t\n\r,.!?;:()[]{}\"'")
    if not _looks_like_clean_answer(candidate):
        return False
    c_key = _normalize_key(candidate)
    a_key = _normalize_key(answer)
    if not c_key or not a_key or c_key == a_key:
        return False
    if c_key in a_key or a_key in c_key:
        return False
    if difflib.SequenceMatcher(None, c_key, a_key).ratio() > 0.72:
        return False
    return True


class QualityScorer:
    W = np.array([0.28, 0.22, 0.20, 0.20, 0.10], dtype=np.float64)

    def score(self, question: str, answer: str, distractors: List[str], importance: float) -> float:
        q_words = question.split()
        q_len = len(q_words)
        answer_words = len(answer.split())

        f_importance = float(np.clip(importance, 0.0, 1.0))
        f_answer = 1.0 if 1 <= answer_words <= 4 else 0.65
        f_question = 1.0 if 6 <= q_len <= 24 else (0.55 if q_len < 6 else 0.60)

        diversity_scores = []
        answer_tokens = _token_set(answer)
        for distractor in distractors:
            d_tokens = _token_set(distractor)
            token_union = answer_tokens | d_tokens
            token_overlap = len(answer_tokens & d_tokens) / len(token_union) if token_union else 0.0
            string_similarity = difflib.SequenceMatcher(None, _normalize_key(answer), _normalize_key(distractor)).ratio()
            diversity_scores.append(1.0 - max(token_overlap, string_similarity * 0.75))
        f_distractors = float(np.mean(diversity_scores)) if diversity_scores else 0.0

        f_format = 1.0 if question.strip().endswith("?") or "______" in question else 0.7
        features = np.array([f_importance, f_answer, f_question, f_distractors, f_format], dtype=np.float64)
        return float(np.clip(np.dot(self.W, features), 0.0, 1.0))


# ════════════════════════════════════════════════════════════════
# MAIN ENGINE
# ════════════════════════════════════════════════════════════════
class DeepQuizEngine:
    def __init__(self):
        self.embedder = EmbeddingModel.get()
        self.qgen = QuestionGenerator.get()
        self.scorer = QualityScorer()
        from difficulty_model import DifficultyClassifier

        self.classifier = DifficultyClassifier(embedder=self.embedder)
        logger.info(
            "🚀 DeepQuizEngine ready | embedder=%s | question_gen_mode=%s | difficulty_model=%s | offline=%s",
            "ok" if self.embedder.available() else "FAILED",
            self.qgen.mode,
            "fine-tuned" if self.classifier.is_trained() else "heuristic (untrained)",
            CONFIG.offline,
        )

    def _rank_by_centrality(self, embeddings: np.ndarray) -> np.ndarray:
        if embeddings.shape[0] < 2:
            return np.ones(embeddings.shape[0], dtype=np.float32)
        centroid = embeddings.mean(axis=0, keepdims=True)
        sims = cosine_similarity(embeddings, centroid).flatten()
        return np.clip(sims, 0.0, 1.0)

    def _cluster_topics(self, embeddings: np.ndarray, n_clusters: int = CONFIG.topic_clusters) -> np.ndarray:
        n = embeddings.shape[0]
        k = min(n_clusters, max(n // 4, 2))
        if k < 2 or n < 2:
            return np.zeros(n, dtype=int)
        try:
            x = normalize(embeddings, norm="l2")
            model = KMeans(n_clusters=k, random_state=CONFIG.seed, n_init=10, max_iter=300)
            labels = model.fit_predict(x)
            logger.info("✓ KMeans clustering: %s topic clusters", k)
            return labels
        except Exception as exc:
            logger.warning("Topic clustering failed (%s); using one cluster", exc)
            return np.zeros(n, dtype=int)

    def _collect_phrase_pool(self, sentences: Sequence[str]) -> List[str]:
        pool: List[str] = []
        seen = set()
        for sent in sentences:
            for phrase, _tag in extract_noun_phrases(sent):
                key = _normalize_key(phrase)
                if key and key not in seen:
                    pool.append(phrase)
                    seen.add(key)
        return pool

    def _semantic_distractors(
        self,
        answer: str,
        answer_sentence: str,
        all_sentences: List[str],
        sentence_embeddings: np.ndarray,
        sentence_idx: int,
        n: int = 3,
    ) -> List[str]:
        out: List[str] = []
        seen = {_normalize_key(answer)}
        answer_word_count = len(answer.split())

        if sentence_embeddings.shape[0] > 1:
            sims = cosine_similarity(sentence_embeddings[sentence_idx:sentence_idx + 1], sentence_embeddings).flatten()
            order = np.argsort(sims)[::-1]
            # First pass: same-topic, similar length.
            for idx in order:
                if idx == sentence_idx or len(out) >= n:
                    continue
                for phrase, _tag in extract_noun_phrases(all_sentences[int(idx)]):
                    key = _normalize_key(phrase)
                    if key in seen:
                        continue
                    if abs(len(phrase.split()) - answer_word_count) <= 1 and _is_valid_distractor(phrase, answer):
                        out.append(phrase)
                        seen.add(key)
                        break
            # Second pass: same-topic, any clean phrase.
            for idx in order:
                if idx == sentence_idx or len(out) >= n:
                    continue
                for phrase, _tag in extract_noun_phrases(all_sentences[int(idx)]):
                    key = _normalize_key(phrase)
                    if key not in seen and _is_valid_distractor(phrase, answer):
                        out.append(phrase)
                        seen.add(key)
                        break
        return out[:n]

    def _build_distractors(
        self,
        answer: str,
        pos: str,
        answer_sentence: str,
        all_sentences: List[str],
        sentence_embeddings: np.ndarray,
        sentence_idx: int,
        phrase_pool: Optional[List[str]] = None,
    ) -> List[str]:
        combined: List[str] = []
        seen = {_normalize_key(answer)}

        def add(candidate: str) -> None:
            key = _normalize_key(candidate)
            if len(combined) >= 3 or key in seen:
                return
            if _is_valid_distractor(candidate, answer):
                combined.append(candidate.strip())
                seen.add(key)

        for candidate in self._semantic_distractors(answer, answer_sentence, all_sentences, sentence_embeddings, sentence_idx, n=3):
            add(candidate)

        if len(combined) < 3:
            for candidate in get_wordnet_distractors(answer, pos, n=6):
                add(candidate)

        if len(combined) < 3 and phrase_pool:
            answer_word_count = len(answer.split())
            preferred = sorted(
                phrase_pool,
                key=lambda p: (abs(len(p.split()) - answer_word_count), difflib.SequenceMatcher(None, _normalize_key(p), _normalize_key(answer)).ratio()),
            )
            for candidate in preferred:
                add(candidate)
                if len(combined) >= 3:
                    break

        if len(combined) < 3 and len(answer.split()) == 1:
            # Last resort only for single-word answers. These are generic but still valid.
            for fb in ["method", "system", "process", "concept", "principle", "structure", "framework", "mechanism", "function"]:
                add(fb)
                if len(combined) >= 3:
                    break

        random.shuffle(combined)
        return combined[:3]

    def _make_question_record(
        self,
        sentence: str,
        answer: str,
        pos: str,
        idx: int,
        sentences: List[str],
        embeddings: np.ndarray,
        importance: np.ndarray,
        clusters: np.ndarray,
        phrase_pool: List[str],
        force_template: bool = False,
    ) -> Optional[Dict]:
        distractors = self._build_distractors(answer, pos, sentence, sentences, embeddings, idx, phrase_pool)
        if len(distractors) < 3:
            return None

        if force_template:
            question = self.qgen._generate_template(sentence, answer)
            was_neural = False
        else:
            question, was_neural = self.qgen.generate(sentence, answer)
        if not question:
            return None

        options = distractors[:3] + [answer]
        # Normalize option display while preserving original correct answer text.
        cleaned_options: List[str] = []
        seen_options = set()
        for option in options:
            key = _normalize_key(option)
            if key not in seen_options:
                cleaned_options.append(option)
                seen_options.add(key)
        if len(cleaned_options) != 4:
            return None
        random.shuffle(cleaned_options)
        correct_idx = cleaned_options.index(answer)

        difficulty = self.classifier.predict(question)
        quality = self.scorer.score(question, answer, distractors, float(importance[idx]))
        return {
            "question": question.strip(),
            "correct": answer,
            "options": cleaned_options,
            "correct_index": correct_idx,
            "difficulty": difficulty,
            "topic_cluster": int(clusters[idx]),
            "quality_score": round(quality, 3),
            "question_type": "neural_qg" if was_neural else "fill_blank",
        }

    def generate(self, raw_text: str, limit: int, grounded_only: bool = False) -> List[Dict]:
        t0 = time.time()
        limit = int(max(1, min(limit, 250)))
        text = _clean_text(raw_text)
        sentences = split_sentences(text)
        if len(sentences) < 2:
            sentences = [s.strip() for s in re.split(r"[.!?]", text) if len(s.split()) >= CONFIG.min_sentence_words]
        if not sentences and text:
            sentences = [text]
        logger.info("✓ %s candidate sentences extracted", len(sentences))

        if not self.embedder.available():
            raise RuntimeError(
                "Sentence embedding model is not available. Run download_models_once.py once with internet, "
                "or disable offline mode until models are cached/downloaded."
            )
        if not sentences:
            return []

        embeddings = self.embedder.encode(sentences, show_progress_bar=False)
        importance = self._rank_by_centrality(embeddings)
        clusters = self._cluster_topics(embeddings)
        ranked_idx = np.argsort(importance)[::-1]
        phrase_pool = self._collect_phrase_pool(sentences)

        results: List[Dict] = []
        used_answers: set[str] = set()
        used_question_keys: set[str] = set()

        def add_record(record: Optional[Dict], answer: str) -> bool:
            if not record:
                return False
            q_key = _normalize_key(record["question"])
            a_key = _normalize_key(answer)
            if q_key in used_question_keys or a_key in used_answers:
                return False
            results.append(record)
            used_answers.add(a_key)
            used_question_keys.add(q_key)
            return True

        # Pass 1: best sentence + best answer per sentence, neural preferred.
        for raw_idx in ranked_idx:
            if len(results) >= limit:
                break
            idx = int(raw_idx)
            sentence = sentences[idx]
            answer_info = get_key_noun_phrase(sentence)
            if not answer_info:
                continue
            answer, pos = answer_info
            if _normalize_key(answer) in used_answers:
                continue
            record = self._make_question_record(
                sentence, answer, pos, idx, sentences, embeddings, importance, clusters, phrase_pool,
                force_template=grounded_only,
            )
            add_record(record, answer)

        # Pass 2: additional noun phrases from high-importance sentences using template questions.
        if len(results) < limit:
            for raw_idx in ranked_idx:
                if len(results) >= limit:
                    break
                idx = int(raw_idx)
                sentence = sentences[idx]
                for answer, pos in extract_noun_phrases(sentence)[:4]:
                    if len(results) >= limit:
                        break
                    if _normalize_key(answer) in used_answers:
                        continue
                    record = self._make_question_record(
                        sentence, answer, pos, idx, sentences, embeddings, importance, clusters, phrase_pool, force_template=True
                    )
                    add_record(record, answer)

        # Final guard: every option must look like readable language. In grounded
        # PDF mode, every question is a fill-in-the-blank sentence copied from
        # the extracted source, so the model cannot invent unrelated wording.
        results = [
            row for row in results
            if _looks_like_clean_answer(str(row.get("correct", "")))
            and all(_looks_like_clean_answer(str(opt)) for opt in row.get("options", []))
        ]
        results.sort(key=lambda row: row["quality_score"], reverse=True)
        elapsed = round(time.time() - t0, 3)
        logger.info("📈 Generated %s/%s questions in %ss | qgen_mode=%s", len(results), limit, elapsed, self.qgen.mode)
        return results[:limit]


_engine_singleton: Optional[DeepQuizEngine] = None


def get_engine() -> DeepQuizEngine:
    global _engine_singleton
    if _engine_singleton is None:
        _engine_singleton = DeepQuizEngine()
    return _engine_singleton
