"""
app.py  —  AI Quiz Generator Backend  v8.0
University of Haripur · BS AI · Muhammad Saad Jadoon

New in v8.0 (vs v7.0):
  • User profile: avatar upload (base64), email/username/password update
  • Quiz attempt tracking  (QuizAttempt table)
  • Quiz delete endpoint
  • Reattempt a session and compare scores
  • Per-session attempt history + score comparison
  • Forgot-password flow (token-based, email-token stored in DB)
  • /api/v1/generate-quiz count range 1-250
  • GET /api/v1/user/{user_id}/profile
  • PATCH /api/v1/user/{user_id}/profile
  • DELETE /api/v1/session/{session_id}
  • POST /api/v1/session/{session_id}/attempt  (save a completed attempt)
  • GET /api/v1/session/{session_id}/attempts  (list attempts with comparison)
  • POST /auth/forgot-password  (returns a reset token — wire to email in prod)
  • POST /auth/reset-password
"""

import re
import time
import uuid
import json
import os
import base64
import binascii
import logging
import hashlib
import hmac
import secrets
import smtplib
import threading
import contextvars
from collections import defaultdict, deque
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Dict, Deque, Tuple

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator, model_validator

from sqlalchemy import (
    create_engine, Column, Integer, String, Text, Float, Boolean,
    DateTime, ForeignKey, JSON, UniqueConstraint, Index, event
)
from sqlalchemy.orm import sessionmaker, Session, declarative_base, relationship
from sqlalchemy import text as sql_text
from werkzeug.security import generate_password_hash, check_password_hash

import pandas as pd

from ml_engine import get_engine
from difficulty_model import load_training_meta
from logging_config import configure_logging

try:
    import fitz
    PDF_SUPPORT = True
except ImportError:
    PDF_SUPPORT = False

configure_logging()
logger = logging.getLogger("AI_QUIZ_GEN")
REQUEST_ID_CTX = contextvars.ContextVar("request_id", default="-")

# ════════════════════════════════════════════════════════════════
# DATABASE
# ════════════════════════════════════════════════════════════════
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./ai_quiz.db").strip()
if DATABASE_URL.startswith("postgres://"):
    # Render/Heroku sometimes expose postgres://, while SQLAlchemy expects postgresql://
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

MAX_TEXT_CHARS = int(os.getenv("MAX_TEXT_CHARS", "200000"))
MAX_PDF_BYTES = int(os.getenv("MAX_PDF_BYTES", str(20 * 1024 * 1024)))
MAX_AVATAR_BYTES = int(os.getenv("MAX_AVATAR_BYTES", str(1024 * 1024)))
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
INDEX_FILE = Path(__file__).with_name("index.html")
AUTH_SECRET = os.getenv("AUTH_SECRET", "").strip()
if not AUTH_SECRET:
    if APP_ENV == "production":
        raise RuntimeError("AUTH_SECRET is required in production")
    AUTH_SECRET = "dev-only-change-me-" + hashlib.sha256(str(INDEX_FILE).encode()).hexdigest()
ACCESS_TOKEN_MINUTES = int(os.getenv("ACCESS_TOKEN_MINUTES", "20"))
REFRESH_TOKEN_DAYS = int(os.getenv("REFRESH_TOKEN_DAYS", "14"))
LOGIN_RATE_LIMIT = int(os.getenv("LOGIN_RATE_LIMIT", "8"))
RESET_RATE_LIMIT = int(os.getenv("RESET_RATE_LIMIT", "5"))
SMTP_HOST = os.getenv("SMTP_HOST", "").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "").strip()
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USERNAME or "no-reply@localhost").strip()
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").strip().lower() in {"1", "true", "yes"}

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine_db = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,
    future=True,
)

if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine_db, "connect")
    def _sqlite_enable_integrity(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()
SessionLocal = sessionmaker(bind=engine_db, autocommit=False, autoflush=False)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id          = Column(Integer, primary_key=True, index=True)
    username    = Column(String(50), unique=True, nullable=False)
    email       = Column(String(100), unique=True, nullable=False)
    password    = Column(String(255), nullable=False)
    avatar_b64  = Column(Text, nullable=True)          # base64 data-URL
    role        = Column(String(20), default="student") # student | teacher
    created_at  = Column(DateTime, default=datetime.utcnow)
    token_version = Column(Integer, default=0, nullable=False)
    profile_json = Column(Text, nullable=False, default="{}")
    preferences_json = Column(Text, nullable=False, default="{}")
    sessions    = relationship("QuizSession", back_populates="owner", cascade="all, delete-orphan")
    reset_tokens = relationship("PasswordResetToken", back_populates="owner", cascade="all, delete-orphan")


class QuizSession(Base):
    __tablename__ = "quiz_sessions"
    id               = Column(Integer, primary_key=True, index=True)
    user_id          = Column(Integer, ForeignKey("users.id"))
    title            = Column(String(255))
    content_summary  = Column(Text)
    total_questions  = Column(Integer)
    quiz_type        = Column(String(20), default="standard")
    processing_time  = Column(Float)
    source_type      = Column(String(20), default="text")
    ml_pipeline      = Column(String(300))
    created_at       = Column(DateTime, default=datetime.utcnow)
    owner            = relationship("User", back_populates="sessions")
    questions        = relationship("QuestionBank", back_populates="session_parent", cascade="all, delete-orphan")
    attempts         = relationship("QuizAttempt", back_populates="session", cascade="all, delete-orphan")


class QuestionBank(Base):
    __tablename__ = "questions"
    id              = Column(Integer, primary_key=True, index=True)
    session_id      = Column(Integer, ForeignKey("quiz_sessions.id"))
    question_body   = Column(Text, nullable=False)
    correct_ans     = Column(String(255))
    distractors_json = Column(Text)
    difficulty      = Column(String(10), default="medium")
    topic_cluster   = Column(Integer, default=0)
    quality_score   = Column(Float, default=0.0)
    question_type   = Column(String(30), default="fill_blank")
    session_parent  = relationship("QuizSession", back_populates="questions")


class QuizAttempt(Base):
    """Stores each time a user completes / re-attempts a session."""
    __tablename__ = "quiz_attempts"
    id            = Column(Integer, primary_key=True, index=True)
    session_id    = Column(Integer, ForeignKey("quiz_sessions.id"))
    user_id       = Column(Integer, ForeignKey("users.id"))
    score         = Column(Integer)          # number correct
    total         = Column(Integer)          # total questions
    pct           = Column(Float)            # score/total * 100
    answers_json  = Column(Text)             # JSON: {question_id: chosen_option_idx}
    attempted_at  = Column(DateTime, default=datetime.utcnow)
    session       = relationship("QuizSession", back_populates="attempts")


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"
    id         = Column(Integer, primary_key=True, index=True)
    user_id    = Column(Integer, ForeignKey("users.id"))
    token      = Column(String(64), unique=True, nullable=False)  # SHA-256 hash
    expires_at = Column(DateTime, nullable=False)
    used       = Column(Integer, default=0)
    owner      = relationship("User", back_populates="reset_tokens")


class Classroom(Base):
    __tablename__ = "classrooms"
    id = Column(Integer, primary_key=True, index=True)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    teacher_code = Column(String(24), nullable=False, index=True)
    class_code = Column(String(24), unique=True, nullable=False, index=True)
    class_key_hash = Column(String(255), nullable=False)
    class_key_hint = Column(String(8), nullable=False)
    name = Column(String(120), nullable=False)
    subject = Column(String(120), default="General", nullable=False)
    section = Column(String(80), default="", nullable=False)
    is_active = Column(Integer, default=1, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    members = relationship("ClassMember", back_populates="classroom", cascade="all, delete-orphan")
    approvals = relationship("ClassApproval", back_populates="classroom", cascade="all, delete-orphan")
    assignments = relationship("Assignment", back_populates="classroom", cascade="all, delete-orphan")


class ClassMember(Base):
    __tablename__ = "class_members"
    __table_args__ = (UniqueConstraint("class_id", "student_id", name="uq_class_student"),)
    id = Column(Integer, primary_key=True, index=True)
    class_id = Column(Integer, ForeignKey("classrooms.id"), nullable=False, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    join_method = Column(String(30), default="class-key", nullable=False)
    status = Column(String(20), default="active", nullable=False)
    joined_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    classroom = relationship("Classroom", back_populates="members")
    student = relationship("User")


class ClassApproval(Base):
    __tablename__ = "class_approvals"
    __table_args__ = (UniqueConstraint("class_id", "approval_value", name="uq_class_approval"),)
    id = Column(Integer, primary_key=True, index=True)
    class_id = Column(Integer, ForeignKey("classrooms.id"), nullable=False, index=True)
    approval_type = Column(String(20), nullable=False)
    approval_value = Column(String(160), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    classroom = relationship("Classroom", back_populates="approvals")


class Assignment(Base):
    __tablename__ = "assignments"
    id = Column(Integer, primary_key=True, index=True)
    class_id = Column(Integer, ForeignKey("classrooms.id"), nullable=False, index=True)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String(160), nullable=False)
    subject = Column(String(120), default="General", nullable=False)
    instructions = Column(Text, default="", nullable=False)
    source_type = Column(String(30), default="create", nullable=False)
    source_content = Column(Text, default="", nullable=False)
    question_count = Column(Integer, default=10, nullable=False)
    time_limit_minutes = Column(Integer, default=0, nullable=False)
    allow_retake = Column(Integer, default=1, nullable=False)
    status = Column(String(20), default="published", nullable=False, index=True)
    due_at = Column(DateTime, nullable=True, index=True)
    published_at = Column(DateTime, nullable=True)
    closed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    classroom = relationship("Classroom", back_populates="assignments")
    teacher = relationship("User")
    targets = relationship("AssignmentTarget", back_populates="assignment", cascade="all, delete-orphan")
    questions = relationship("AssignmentQuestion", back_populates="assignment", cascade="all, delete-orphan")
    attempts = relationship("AssignmentAttempt", back_populates="assignment", cascade="all, delete-orphan")


class AssignmentTarget(Base):
    __tablename__ = "assignment_targets"
    __table_args__ = (UniqueConstraint("assignment_id", "student_id", name="uq_assignment_student"),)
    id = Column(Integer, primary_key=True, index=True)
    assignment_id = Column(Integer, ForeignKey("assignments.id"), nullable=False, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    assigned_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    assignment = relationship("Assignment", back_populates="targets")
    student = relationship("User")


class AssignmentQuestion(Base):
    __tablename__ = "assignment_questions"
    id = Column(Integer, primary_key=True, index=True)
    assignment_id = Column(Integer, ForeignKey("assignments.id"), nullable=False, index=True)
    position = Column(Integer, nullable=False)
    question_body = Column(Text, nullable=False)
    options_json = Column(Text, nullable=False)
    correct_index = Column(Integer, nullable=False)
    explanation = Column(Text, default="", nullable=False)
    assignment = relationship("Assignment", back_populates="questions")


class AssignmentAttempt(Base):
    __tablename__ = "assignment_attempts"
    __table_args__ = (UniqueConstraint("assignment_id", "student_id", "attempt_no", name="uq_assignment_attempt_no"),)
    id = Column(Integer, primary_key=True, index=True)
    assignment_id = Column(Integer, ForeignKey("assignments.id"), nullable=False, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    attempt_no = Column(Integer, nullable=False, default=1)
    status = Column(String(20), nullable=False, default="in_progress", index=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=True, index=True)
    submitted_at = Column(DateTime, nullable=True, index=True)
    score = Column(Integer, nullable=True)
    total = Column(Integer, nullable=True)
    answered_count = Column(Integer, default=0, nullable=False)
    answers_json = Column(Text, default="{}", nullable=False)
    assignment = relationship("Assignment", back_populates="attempts")
    student = relationship("User")



class QuizDraft(Base):
    __tablename__ = "quiz_drafts"
    id = Column(Integer, primary_key=True, index=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String(160), nullable=False)
    source_type = Column(String(30), nullable=False, default="text")
    source_content = Column(Text, default="", nullable=False)
    status = Column(String(20), nullable=False, default="review", index=True)
    requested_count = Column(Integer, nullable=False, default=10)
    approved_count = Column(Integer, nullable=False, default=0)
    warnings_json = Column(Text, nullable=False, default="[]")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    questions = relationship("QuizDraftQuestion", back_populates="draft", cascade="all, delete-orphan", order_by="QuizDraftQuestion.position")


class QuizDraftQuestion(Base):
    __tablename__ = "quiz_draft_questions"
    id = Column(Integer, primary_key=True, index=True)
    draft_id = Column(Integer, ForeignKey("quiz_drafts.id"), nullable=False, index=True)
    position = Column(Integer, nullable=False)
    question_body = Column(Text, nullable=False)
    options_json = Column(Text, nullable=False)
    correct_index = Column(Integer, nullable=False)
    explanation = Column(Text, default="", nullable=False)
    difficulty = Column(String(10), default="medium", nullable=False)
    topic_cluster = Column(Integer, default=0, nullable=False)
    quality_score = Column(Float, default=0.0, nullable=False)
    status = Column(String(20), default="pending", nullable=False, index=True)
    validation_json = Column(Text, default="[]", nullable=False)
    draft = relationship("QuizDraft", back_populates="questions")


class RevisionItem(Base):
    __tablename__ = "revision_items"
    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    source_type = Column(String(30), nullable=False, default="personal_quiz")
    source_id = Column(Integer, nullable=True, index=True)
    title = Column(String(180), nullable=False)
    score_pct = Column(Float, nullable=False, default=0)
    question_count = Column(Integer, nullable=False, default=0)
    weak_questions_json = Column(Text, nullable=False, default="[]")
    status = Column(String(20), nullable=False, default="active", index=True)
    best_retake_pct = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class RevisionNote(Base):
    __tablename__ = "revision_notes"
    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String(180), nullable=False)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class StudyPlan(Base):
    __tablename__ = "study_plans"
    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String(180), nullable=False)
    target_pct = Column(Integer, nullable=False, default=80)
    days = Column(Integer, nullable=False, default=7)
    plan_json = Column(Text, nullable=False, default="[]")
    status = Column(String(20), nullable=False, default="active")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class TeacherRevisionRecommendation(Base):
    __tablename__ = "teacher_revision_recommendations"
    id = Column(Integer, primary_key=True, index=True)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    class_id = Column(Integer, ForeignKey("classrooms.id"), nullable=False, index=True)
    title = Column(String(180), nullable=False)
    message = Column(Text, nullable=False)
    due_at = Column(DateTime, nullable=True)
    status = Column(String(20), nullable=False, default="active")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class AuditLog(Base):
    """Append-only security and academic activity trail."""
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_actor_created", "actor_user_id", "created_at"),
        Index("ix_audit_action_created", "action", "created_at"),
        Index("ix_audit_entity", "entity_type", "entity_id"),
    )
    id = Column(Integer, primary_key=True)
    actor_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    actor_role = Column(String(20), nullable=True)
    action = Column(String(80), nullable=False, index=True)
    entity_type = Column(String(60), nullable=True)
    entity_id = Column(String(80), nullable=True)
    method = Column(String(10), nullable=False)
    path = Column(String(300), nullable=False)
    status_code = Column(Integer, nullable=False)
    ip_hash = Column(String(64), nullable=True)
    user_agent = Column(String(300), nullable=True)
    details_json = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id         = Column(Integer, primary_key=True, index=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String(64), unique=True, nullable=False, index=True)
    expires_at = Column(DateTime, nullable=False)
    revoked    = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


AUTO_CREATE_SCHEMA = os.getenv("AUTO_CREATE_SCHEMA", "true" if APP_ENV != "production" else "false").strip().lower() in {"1", "true", "yes"}
if AUTO_CREATE_SCHEMA:
    Base.metadata.create_all(bind=engine_db)
else:
    logger.info("AUTO_CREATE_SCHEMA disabled; expecting Alembic migrations to be applied")


def _ensure_sqlite_light_migrations() -> None:
    """
    SQLite create_all() creates missing tables, but it does not add new columns
    to old local databases. This keeps older ai_quiz.db files compatible when
    the app is upgraded from v7/v8 without requiring Alembic.
    """
    if not DATABASE_URL.startswith("sqlite"):
        return

    migrations = {
        "users": [
            ("avatar_b64", "TEXT"),
            ("role", "VARCHAR(20) DEFAULT 'student'"),
            ("token_version", "INTEGER DEFAULT 0"),
            ("profile_json", "TEXT DEFAULT '{}'") ,
            ("preferences_json", "TEXT DEFAULT '{}'") ,
        ],
        "quiz_sessions": [
            ("source_type", "VARCHAR(20) DEFAULT 'text'"),
            ("ml_pipeline", "VARCHAR(300)"),
        ],
        "questions": [
            ("question_type", "VARCHAR(30) DEFAULT 'fill_blank'"),
        ],
    }

    try:
        with engine_db.begin() as conn:
            available = {row[0] for row in conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
            for table, columns in migrations.items():
                if table not in available:
                    continue
                existing = {
                    row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
                }
                for col_name, col_type in columns:
                    if col_name not in existing:
                        conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}")
                        logger.info("SQLite migration applied: %s.%s", table, col_name)
    except Exception as exc:
        logger.warning("SQLite light migration skipped/failed: %s", exc)


_ensure_sqlite_light_migrations()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ════════════════════════════════════════════════════════════════
# PDF EXTRACTION
# ════════════════════════════════════════════════════════════════
def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    if not PDF_SUPPORT:
        raise HTTPException(500, "PDF support not available. Install pymupdf.")
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        chunks = []
        for page_num in range(len(doc)):
            page = doc.load_page(page_num)
            t = page.get_text("text")
            t = re.sub(r"\n{3,}", "\n\n", t)
            t = re.sub(r"[ \t]+", " ", t)
            chunks.append(t.strip())
        doc.close()
        combined = "\n\n".join(chunks)
        combined = re.sub(r"\n([a-z])", r" \1", combined)
        combined = re.sub(r"-\n(\w)", r"\1", combined)
        combined = re.sub(r"\n{2,}", ". ", combined)
        combined = re.sub(r"\s+", " ", combined)
        return combined.strip()
    except Exception as e:
        raise HTTPException(500, f"PDF extraction failed: {str(e)}")


def _pdf_text_quality(text: str) -> tuple[bool, str]:
    """Reject unreadable font-encoded PDF text before MCQ generation."""
    sample = str(text or "")[:12000]
    if len(sample.strip()) < 80:
        return False, "The PDF does not contain enough readable text."
    printable = sum(ch.isprintable() or ch in "\n\t" for ch in sample) / max(len(sample), 1)
    alpha = sum(ch.isalpha() for ch in sample) / max(len(sample), 1)
    words = re.findall(r"[A-Za-z]{2,}", sample)
    vowel_words = sum(bool(re.search(r"[aeiouAEIOU]", w)) for w in words)
    readable_word_ratio = vowel_words / max(len(words), 1)
    suspicious = re.findall(r"\b(?=[A-Za-z0-9_+/-]{4,}\b)(?=[A-Za-z0-9_+/-]*\d)(?=[A-Za-z0-9_+/-]*[A-Za-z])[A-Za-z0-9_+/-]+\b", sample)
    suspicious_ratio = len(suspicious) / max(len(words), 1)
    if printable < 0.97 or alpha < 0.45 or readable_word_ratio < 0.72 or suspicious_ratio > 0.12:
        return False, (
            "This PDF's text encoding is unreadable, so reliable MCQs cannot be generated. "
            "Please use a text-based PDF, re-export the PDF, or run OCR first."
        )
    return True, ""


def _validate_avatar_data_url(value: Optional[str]) -> Optional[str]:
    """
    Accept only small base64 image data URLs to avoid huge DB rows and invalid
    profile images. Empty string clears the avatar.
    """
    if value is None:
        return None

    value = value.strip()
    if value == "":
        return None

    match = re.match(r"^data:image/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\r\n]+)$", value, re.IGNORECASE)
    if not match:
        raise ValueError("Avatar must be a PNG, JPG, JPEG, or WEBP base64 data URL")

    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("Avatar base64 data is invalid")

    if len(raw) > MAX_AVATAR_BYTES:
        max_mb = round(MAX_AVATAR_BYTES / (1024 * 1024), 2)
        raise ValueError(f"Avatar image too large — max {max_mb}MB")

    return value


def _require_index_file() -> Path:
    if not INDEX_FILE.exists():
        raise HTTPException(500, "index.html not found next to app.py")
    return INDEX_FILE


# ════════════════════════════════════════════════════════════════
# ML ENGINE
# ════════════════════════════════════════════════════════════════
DB_MIGRATION_MODE = os.getenv("DB_MIGRATION_MODE", "false").strip().lower() in {"1", "true", "yes"}
if DB_MIGRATION_MODE:
    quiz_engine = None
    logger.info("Database migration mode: ML engine loading skipped")
else:
    logger.info("=" * 70)
    logger.info("🚀 Loading AI Quiz Generator deep learning engine…")
    quiz_engine = get_engine()
    logger.info("=" * 70)


# ════════════════════════════════════════════════════════════════
# PYDANTIC SCHEMAS
# ════════════════════════════════════════════════════════════════
class SignupSchema(BaseModel):
    username: str
    email: str
    password: str
    role: Optional[str] = "student"

    @field_validator("username")
    @classmethod
    def val_username(cls, v):
        v = v.strip()
        if len(v) < 3 or len(v) > 30:
            raise ValueError("Username must be 3-30 characters")
        if not re.match(r"^[a-zA-Z0-9_]+$", v):
            raise ValueError("Only letters, numbers and underscores allowed")
        return v

    @field_validator("email")
    @classmethod
    def val_email(cls, v):
        v = v.strip().lower()
        if not re.match(r"^[\w\.-]+@[\w\.-]+\.\w{2,}$", v):
            raise ValueError("Invalid email format")
        return v

    @field_validator("password")
    @classmethod
    def val_password(cls, v):
        errs = []
        if len(v) < 8: errs.append("8+ chars")
        if not re.search(r"[A-Z]", v): errs.append("uppercase letter")
        if not re.search(r"[a-z]", v): errs.append("lowercase letter")
        if not re.search(r"\d", v): errs.append("digit")
        if not re.search(r"[!@#$%^&*(),.?]", v): errs.append("special char")
        if errs:
            raise ValueError(f'Password needs: {", ".join(errs)}')
        return v

    @field_validator("role")
    @classmethod
    def val_role(cls, v):
        v = (v or "student").strip().lower()
        if v not in {"student", "teacher"}:
            raise ValueError("Role must be student or teacher")
        return v


class LoginSchema(BaseModel):
    username: str
    password: str


class RefreshSchema(BaseModel):
    refresh_token: str


class LogoutSchema(BaseModel):
    refresh_token: Optional[str] = None


class QuizRequest(BaseModel):
    user_id: int
    text_content: str
    count: int = 10
    quiz_title: Optional[str] = None

    @field_validator("count")
    @classmethod
    def val_count(cls, v):
        if not (1 <= v <= 250):
            raise ValueError("Count must be 1-250")
        return v

    @field_validator("text_content")
    @classmethod
    def val_text(cls, v):
        v = v.strip()
        if len(v) < 50:
            raise ValueError("Minimum 50 characters required")
        if len(v) > MAX_TEXT_CHARS:
            raise ValueError(f"Text too large. Maximum allowed characters: {MAX_TEXT_CHARS}")
        return v


class ProfileUpdateSchema(BaseModel):
    username: Optional[str] = None
    email: Optional[str] = None
    avatar_b64: Optional[str] = None
    academic_profile: Optional[Dict] = None
    preferences: Optional[Dict] = None

    @field_validator("avatar_b64")
    @classmethod
    def val_avatar(cls, v):
        return _validate_avatar_data_url(v)


class PasswordChangeSchema(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def val_new_pw(cls, v):
        errs = []
        if len(v) < 8: errs.append("8+ chars")
        if not re.search(r"[A-Z]", v): errs.append("uppercase letter")
        if not re.search(r"[a-z]", v): errs.append("lowercase letter")
        if not re.search(r"\d", v): errs.append("digit")
        if not re.search(r"[!@#$%^&*(),.?]", v): errs.append("special char")
        if errs:
            raise ValueError(f'Password needs: {", ".join(errs)}')
        return v


class ClassCreateSchema(BaseModel):
    name: str
    subject: str = "General"
    section: str = ""
    class_key: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v):
        v = re.sub(r"\s+", " ", v.strip())
        if not 2 <= len(v) <= 120:
            raise ValueError("Class name must be 2-120 characters")
        return v

    @field_validator("class_key")
    @classmethod
    def validate_key(cls, v):
        if v is None or not v.strip(): return None
        v = re.sub(r"[^A-Za-z0-9]", "", v).upper()
        if not 4 <= len(v) <= 12:
            raise ValueError("Class key must be 4-12 letters/numbers")
        return v


class ClassUpdateSchema(BaseModel):
    name: Optional[str] = None
    subject: Optional[str] = None
    section: Optional[str] = None
    class_key: Optional[str] = None


class ClassJoinSchema(BaseModel):
    code: str
    class_key: Optional[str] = None


class ClassApprovalSchema(BaseModel):
    value: str


class AssignmentCreateSchema(BaseModel):
    class_id: int
    title: str
    subject: str = "General"
    instructions: str = ""
    source_type: str = "create"
    source_content: str = ""
    question_count: int = 10
    time_limit_minutes: int = 0
    allow_retake: bool = True
    status: str = "published"
    due_at: Optional[datetime] = None
    target_student_ids: list[int] = []
    questions: list[dict] = []

    @field_validator("title")
    @classmethod
    def assignment_title(cls, value):
        value = re.sub(r"\s+", " ", (value or "").strip())
        if not 2 <= len(value) <= 160:
            raise ValueError("Assignment title must be 2-160 characters")
        return value

    @field_validator("question_count")
    @classmethod
    def assignment_count(cls, value):
        if not 1 <= value <= 250:
            raise ValueError("Question count must be 1-250")
        return value

    @field_validator("time_limit_minutes")
    @classmethod
    def assignment_timer(cls, value):
        if not 0 <= value <= 300:
            raise ValueError("Time limit must be 0-300 minutes")
        return value

    @field_validator("status")
    @classmethod
    def assignment_status(cls, value):
        value = value.strip().lower()
        if value not in {"draft", "published", "closed"}:
            raise ValueError("Status must be draft, published, or closed")
        return value


class AssignmentUpdateSchema(BaseModel):
    title: Optional[str] = None
    subject: Optional[str] = None
    instructions: Optional[str] = None
    source_type: Optional[str] = None
    source_content: Optional[str] = None
    question_count: Optional[int] = None
    time_limit_minutes: Optional[int] = None
    allow_retake: Optional[bool] = None
    status: Optional[str] = None
    due_at: Optional[datetime] = None
    target_student_ids: Optional[list[int]] = None
    questions: Optional[list[dict]] = None


class AssignmentAnswerSaveSchema(BaseModel):
    answers: Dict[str, int] = {}

class AssignmentSubmitSchema(BaseModel):
    answers: Dict[str, int] = {}


class DraftCreateSchema(BaseModel):
    title: str = "Untitled quiz"
    source_type: str = "text"
    source_content: str
    count: int = 10
    auto_approve_quality: float = 0.72

    @field_validator("count")
    @classmethod
    def draft_count(cls, value):
        if not 1 <= value <= 100:
            raise ValueError("Professional review drafts support 1-100 questions")
        return value

    @field_validator("source_type")
    @classmethod
    def draft_source(cls, value):
        value = value.strip().lower()
        if value not in {"text", "manual_mcq", "mcq_text"}:
            raise ValueError("source_type must be text, manual_mcq, or mcq_text")
        return value


class DraftQuestionUpdateSchema(BaseModel):
    question: Optional[str] = None
    options: Optional[list[str]] = None
    correct_index: Optional[int] = None
    explanation: Optional[str] = None
    difficulty: Optional[str] = None
    status: Optional[str] = None
    position: Optional[int] = None


class DraftFinalizeSchema(BaseModel):
    title: Optional[str] = None
    approved_only: bool = True

class ForgotPasswordSchema(BaseModel):
    email: str


class ResetPasswordSchema(BaseModel):
    token: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def val_pw(cls, v):
        errs = []
        if len(v) < 8: errs.append("8+ chars")
        if not re.search(r"[A-Z]", v): errs.append("uppercase")
        if not re.search(r"[a-z]", v): errs.append("lowercase")
        if not re.search(r"\d", v): errs.append("digit")
        if not re.search(r"[!@#$%^&*(),.?]", v): errs.append("special char")
        if errs:
            raise ValueError(f'Password needs: {", ".join(errs)}')
        return v


class AttemptSaveSchema(BaseModel):
    user_id: int
    score: int
    total: int
    answers: Dict[str, int]   # {question_id_str: chosen_option_index}

    @field_validator("total")
    @classmethod
    def val_total(cls, v):
        if v <= 0:
            raise ValueError("Total must be greater than 0")
        return v

    @field_validator("score")
    @classmethod
    def val_score(cls, v):
        if v < 0:
            raise ValueError("Score cannot be negative")
        return v

    @model_validator(mode="after")
    def val_score_not_over_total(self):
        if self.score > self.total:
            raise ValueError("Score cannot be greater than total")
        return self


class RenameSessionSchema(BaseModel):
    user_id: int
    title: str

    @field_validator("title")
    @classmethod
    def val_title(cls, v):
        v = re.sub(r"\s+", " ", (v or "").strip())
        if not v:
            raise ValueError("Quiz name is required")
        if len(v) > 80:
            raise ValueError("Quiz name must be 80 characters or less")
        return v


# ════════════════════════════════════════════════════════════════
# AUTHENTICATION / SECURITY HELPERS
# ════════════════════════════════════════════════════════════════
_rate_lock = threading.Lock()
_rate_buckets: Dict[str, Deque[float]] = defaultdict(deque)


def _rate_limit(request: Request, bucket: str, limit: int, window_seconds: int = 60) -> None:
    client = request.client.host if request.client else "unknown"
    key = f"{bucket}:{client}"
    now = time.time()
    with _rate_lock:
        q = _rate_buckets[key]
        while q and q[0] <= now - window_seconds:
            q.popleft()
        if len(q) >= limit:
            retry = max(1, int(window_seconds - (now - q[0])))
            raise HTTPException(429, f"Too many requests. Try again in {retry} seconds.")
        q.append(now)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _sign_access_token(user: User) -> str:
    now = int(time.time())
    payload = {
        "sub": str(user.id), "role": user.role or "student",
        "ver": int(user.token_version or 0), "iat": now,
        "exp": now + ACCESS_TOKEN_MINUTES * 60, "typ": "access",
    }
    header = {"alg": "HS256", "typ": "JWT"}
    h = _b64url(json.dumps(header, separators=(",", ":")).encode())
    p = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64url(hmac.new(AUTH_SECRET.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
    return f"{h}.{p}.{sig}"


def _decode_access_token(token: str) -> dict:
    try:
        h, p, sig = token.split(".")
        expected = _b64url(hmac.new(AUTH_SECRET.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            raise ValueError("bad signature")
        payload = json.loads(_b64url_decode(p))
        if payload.get("typ") != "access" or int(payload.get("exp", 0)) <= int(time.time()):
            raise ValueError("expired")
        return payload
    except Exception:
        raise HTTPException(401, "Authentication required or session expired", headers={"WWW-Authenticate": "Bearer"})


def _token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _issue_token_pair(db: Session, user: User) -> dict:
    raw_refresh = secrets.token_urlsafe(48)
    db.add(RefreshToken(
        user_id=user.id,
        token_hash=_token_hash(raw_refresh),
        expires_at=datetime.utcnow() + timedelta(days=REFRESH_TOKEN_DAYS),
    ))
    db.commit()
    return {
        "access_token": _sign_access_token(user),
        "refresh_token": raw_refresh,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_MINUTES * 60,
    }


def _auth_payload(user: User, tokens: dict) -> dict:
    return {
        "status": "success", "user_id": user.id, "username": user.username,
        "email": user.email, "avatar_b64": user.avatar_b64,
        "role": user.role or "student", **tokens,
    }


def get_current_user(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Authentication required", headers={"WWW-Authenticate": "Bearer"})
    payload = _decode_access_token(authorization.split(" ", 1)[1].strip())
    user = db.query(User).filter(User.id == int(payload["sub"])).first()
    if not user or int(user.token_version or 0) != int(payload.get("ver", -1)):
        raise HTTPException(401, "Session is no longer valid", headers={"WWW-Authenticate": "Bearer"})
    return user


def _require_self(user_id: int, current_user: User) -> None:
    if user_id != current_user.id:
        raise HTTPException(403, "You are not allowed to access another user's data")


def _send_reset_email(recipient: str, raw_token: str) -> bool:
    if not SMTP_HOST:
        return False
    msg = EmailMessage()
    msg["Subject"] = "AI Quiz Generator password reset code"
    msg["From"] = SMTP_FROM
    msg["To"] = recipient
    msg.set_content(
        "Use this one-time reset code within 60 minutes:\n\n"
        f"{raw_token}\n\nIf you did not request this, ignore this email."
    )
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as smtp:
            if SMTP_USE_TLS:
                smtp.starttls()
            if SMTP_USERNAME:
                smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
            smtp.send_message(msg)
        return True
    except Exception:
        logger.exception("Password reset email delivery failed")
        return False


# ════════════════════════════════════════════════════════════════
# HELPERS
# ════════════════════════════════════════════════════════════════
def _quiz_type_for(count: int) -> str:
    if count <= 10: return "quick"
    if count <= 25: return "standard"
    if count <= 50: return "extended"
    if count <= 100: return "full"
    return "custom"


def _clean_session_title(title: Optional[str], fallback: str) -> str:
    title = re.sub(r"\s+", " ", (title or "").strip())
    if not title:
        title = fallback
    return title[:80]


def _persist_session(db, user_id, title, summary, questions, elapsed, source_type):
    quiz_type = _quiz_type_for(len(questions))
    session = QuizSession(
        user_id=user_id, title=title,
        content_summary=summary[:300],
        total_questions=len(questions),
        quiz_type=quiz_type,
        processing_time=elapsed,
        source_type=source_type,
        ml_pipeline="SentenceTransformer→KMeans→T5-QG→DistractorMining→PyTorchDifficultyNet→NumPyScorer",
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    for q in questions:
        db.add(QuestionBank(
            session_id=session.id,
            question_body=q["question"],
            correct_ans=q["correct"],
            distractors_json="|".join(q["options"]),
            difficulty=q["difficulty"],
            topic_cluster=q["topic_cluster"],
            quality_score=q["quality_score"],
            question_type=q.get("question_type", "fill_blank"),
        ))
    db.commit()
    return session


def _build_stats(questions: list) -> dict:
    if not questions:
        return {}
    df = pd.DataFrame(questions)
    return {
        "easy":       int((df["difficulty"] == "easy").sum()),
        "medium":     int((df["difficulty"] == "medium").sum()),
        "hard":       int((df["difficulty"] == "hard").sum()),
        "avg_quality": round(float(df["quality_score"].mean()), 3),
        "clusters":   int(df["topic_cluster"].nunique()),
        "neural_qg":  int((df["question_type"] == "neural_qg").sum()),
        "fill_blank": int((df["question_type"] == "fill_blank").sum()),
    }


def _serialize_questions(questions):
    return [
        {
            "id": q.id,
            "question": q.question_body,
            "correct": q.correct_ans,
            "options": q.distractors_json.split("|") if q.distractors_json else [],
            "correct_index": (q.distractors_json.split("|").index(q.correct_ans)
                              if q.distractors_json and q.correct_ans in q.distractors_json.split("|")
                              else 0),
            "difficulty": q.difficulty,
            "topic_cluster": q.topic_cluster,
            "quality_score": q.quality_score,
            "question_type": q.question_type,
        }
        for q in questions
    ]


def _require_teacher(user: User) -> None:
    if (user.role or "student").lower() != "teacher":
        raise HTTPException(403, "Teacher access required")


def _new_unique_code(db: Session, prefix: str, field) -> str:
    for _ in range(20):
        code = f"{prefix}-" + secrets.token_hex(3).upper()
        if not db.query(Classroom).filter(field == code).first():
            return code
    raise HTTPException(500, "Could not generate a unique class code")


def _teacher_code_for(db: Session, teacher_id: int) -> str:
    existing = db.query(Classroom).filter(Classroom.teacher_id == teacher_id).first()
    return existing.teacher_code if existing else _new_unique_code(db, "TCH", Classroom.teacher_code)


def _student_code(user: User) -> str:
    base = re.sub(r"[^A-Za-z0-9]", "", user.username or "STD")[:8].upper() or "STD"
    return f"STD-{base}-{user.id:04d}"


def _class_payload(c: Classroom, db: Session, include_members: bool = False) -> dict:
    teacher = db.query(User).filter(User.id == c.teacher_id).first()
    approvals = db.query(ClassApproval).filter(ClassApproval.class_id == c.id).all()
    data = {
        "id": c.id, "teacherCode": c.teacher_code, "code": c.class_code, "classCode": c.class_code,
        "className": c.name, "subject": c.subject, "section": c.section,
        "classKey": c.class_key_hint, "createdAt": c.created_at.isoformat(),
        "teacherName": teacher.username if teacher else "Teacher",
        "teacherEmail": teacher.email if teacher else "",
        "allowedStudents": [a.approval_value for a in approvals if a.approval_type == "student_code"],
        "allowedEmails": [a.approval_value for a in approvals if a.approval_type == "email"],
    }
    if include_members:
        rows = db.query(ClassMember).filter(ClassMember.class_id == c.id, ClassMember.status == "active").all()
        data["members"] = [{
            "user_id": m.student.id, "username": m.student.username, "email": m.student.email,
            "fullName": m.student.username, "studentCode": _student_code(m.student),
            "joinedAt": m.joined_at.isoformat(), "joinMethod": m.join_method,
        } for m in rows]
    return data


def _assignment_payload(a: Assignment, db: Session, include_content: bool = True) -> dict:
    c = a.classroom or db.query(Classroom).filter(Classroom.id == a.class_id).first()
    teacher = a.teacher or db.query(User).filter(User.id == a.teacher_id).first()
    target_ids = [t.student_id for t in a.targets]
    due = a.due_at.isoformat() if a.due_at else ""
    data = {
        "id": a.id, "assignmentId": a.id, "classId": a.class_id,
        "classCode": c.class_code if c else "", "className": c.name if c else "Class",
        "teacherId": a.teacher_id, "teacherName": teacher.username if teacher else "Teacher",
        "teacherCode": c.teacher_code if c else "", "title": a.title, "subject": a.subject,
        "instructions": a.instructions, "sourceType": a.source_type, "count": a.question_count,
        "timeLimitMinutes": a.time_limit_minutes, "allowRetake": bool(a.allow_retake),
        "status": a.status, "due": due[:10] if due else "", "dueAt": due,
        "targetStudentIds": target_ids, "createdAt": a.created_at.isoformat(),
        "updatedAt": a.updated_at.isoformat(),
    }
    if include_content:
        data["content"] = a.source_content
        data["quiz"] = [{
            "id": q.id, "question": q.question_body,
            "options": json.loads(q.options_json or "[]"),
            "correct_index": q.correct_index,
            "correct": (json.loads(q.options_json or "[]")[q.correct_index] if json.loads(q.options_json or "[]") and 0 <= q.correct_index < len(json.loads(q.options_json or "[]")) else ""),
            "explanation": q.explanation or "",
        } for q in sorted(a.questions, key=lambda item: item.position)]
    return data


def _teacher_assignment(db: Session, assignment_id: int, user: User) -> Assignment:
    _require_teacher(user)
    a = db.query(Assignment).filter(Assignment.id == assignment_id, Assignment.teacher_id == user.id).first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    return a


# ════════════════════════════════════════════════════════════════
# FASTAPI APP
# ════════════════════════════════════════════════════════════════
app = FastAPI(
    title="AI Quiz Generator",
    description="Deep Learning MCQ generation — Muhammad Saad Jadoon, UoH BS AI",
    version="10.0-production-ready",
)

ASSETS_DIR = Path(__file__).with_name("assets")
if not ASSETS_DIR.exists():
    raise RuntimeError("Frontend assets directory is missing")
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")

if APP_ENV == "production" and (not CORS_ORIGINS or "*" in CORS_ORIGINS):
    raise RuntimeError("CORS_ORIGINS must list trusted frontend origins in production")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


def _audit_action_from_request(request: Request) -> str:
    path = request.url.path.strip("/") or "root"
    parts = [p for p in path.split("/") if p and not p.isdigit()]
    return f"{request.method.lower()}:" + ":".join(parts[-3:])


@app.middleware("http")
async def production_request_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    token = REQUEST_ID_CTX.set(request_id)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("Unhandled request failure", extra={"request_id": request_id})
        raise
    finally:
        REQUEST_ID_CTX.reset(token)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if APP_ENV == "production":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    logger.info(
        "%s %s -> %s in %sms", request.method, request.url.path,
        response.status_code, elapsed_ms, extra={"request_id": request_id}
    )
    return response


@app.middleware("http")
async def audit_mutating_requests(request: Request, call_next):
    response = await call_next(request)
    if request.method in {"POST", "PATCH", "PUT", "DELETE"} and request.url.path.startswith(("/auth/", "/api/")):
        actor_id = None
        actor_role = None
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            try:
                payload = _decode_access_token(auth.split(" ", 1)[1].strip())
                actor_id = int(payload.get("sub")) if payload.get("sub") is not None else None
                actor_role = payload.get("role")
            except Exception:
                pass
        forwarded = request.headers.get("x-forwarded-for", "")
        remote = (forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else ""))
        ip_hash = hashlib.sha256((AUTH_SECRET + remote).encode()).hexdigest() if remote else None
        db = SessionLocal()
        try:
            db.add(AuditLog(
                actor_user_id=actor_id, actor_role=actor_role, action=_audit_action_from_request(request),
                entity_type=request.url.path.split("/")[3] if len(request.url.path.split("/")) > 3 else None,
                entity_id=next((part for part in request.url.path.split("/") if part.isdigit()), None),
                method=request.method, path=request.url.path[:300], status_code=response.status_code,
                ip_hash=ip_hash, user_agent=request.headers.get("user-agent", "")[:300],
                details_json=json.dumps({"query": str(request.url.query)[:500]}),
            ))
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("Audit log write failed")
        finally:
            db.close()
    return response


@app.get("/api/v1/audit-logs")
def list_audit_logs(limit: int = 100, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if (current_user.role or "student") != "teacher":
        raise HTTPException(403, "Teacher access required")
    limit = max(1, min(limit, 500))
    rows = db.query(AuditLog).filter(AuditLog.actor_user_id == current_user.id).order_by(AuditLog.created_at.desc()).limit(limit).all()
    return {"status": "success", "logs": [{
        "id": r.id, "action": r.action, "entity_type": r.entity_type, "entity_id": r.entity_id,
        "method": r.method, "path": r.path, "status_code": r.status_code,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]}


@app.get("/", include_in_schema=False)
def serve_frontend():
    return FileResponse(_require_index_file())


@app.get("/index.html", include_in_schema=False)
def serve_index():
    return FileResponse(_require_index_file())


# ── AUTH ───────────────────────────────────────────────────────
@app.post("/auth/signup")
def signup(data: SignupSchema, request: Request, db: Session = Depends(get_db)):
    _rate_limit(request, "signup", 5, 300)
    if db.query(User).filter(User.username == data.username).first():
        raise HTTPException(400, "Username already taken")
    if db.query(User).filter(User.email == data.email).first():
        raise HTTPException(400, "Email already registered")
    user = User(username=data.username, email=data.email,
                password=generate_password_hash(data.password), role=data.role or "student")
    db.add(user); db.commit(); db.refresh(user)
    return _auth_payload(user, _issue_token_pair(db, user))


@app.post("/auth/login")
def login(data: LoginSchema, request: Request, db: Session = Depends(get_db)):
    _rate_limit(request, "login", LOGIN_RATE_LIMIT, 60)
    user = db.query(User).filter(User.username == data.username.strip()).first()
    if not user or not check_password_hash(user.password, data.password):
        raise HTTPException(401, "Invalid credentials")
    return _auth_payload(user, _issue_token_pair(db, user))


@app.post("/auth/refresh")
def refresh_access(data: RefreshSchema, request: Request, db: Session = Depends(get_db)):
    _rate_limit(request, "refresh", 30, 60)
    rec = db.query(RefreshToken).filter(
        RefreshToken.token_hash == _token_hash(data.refresh_token), RefreshToken.revoked == 0
    ).first()
    if not rec or rec.expires_at <= datetime.utcnow():
        raise HTTPException(401, "Refresh session expired. Please sign in again.")
    user = db.query(User).filter(User.id == rec.user_id).first()
    if not user:
        raise HTTPException(401, "Account no longer exists")
    # Rotation prevents replay of a stolen refresh token.
    rec.revoked = 1
    db.commit()
    return _auth_payload(user, _issue_token_pair(db, user))


@app.post("/auth/logout")
def logout_api(data: LogoutSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if data.refresh_token:
        rec = db.query(RefreshToken).filter(
            RefreshToken.user_id == current_user.id,
            RefreshToken.token_hash == _token_hash(data.refresh_token),
        ).first()
        if rec:
            rec.revoked = 1
            db.commit()
    return {"status": "success", "message": "Signed out"}


@app.get("/auth/me")
def auth_me(current_user: User = Depends(get_current_user)):
    return _auth_payload(current_user, {})


@app.post("/auth/forgot-password")
def forgot_password(data: ForgotPasswordSchema, request: Request, db: Session = Depends(get_db)):
    _rate_limit(request, "forgot", RESET_RATE_LIMIT, 900)
    user = db.query(User).filter(User.email == data.email.strip().lower()).first()
    generic = {"status": "success", "ok": True,
               "message": "If that email is registered, reset instructions have been sent.",
               "expires_in_minutes": 60}
    if not user:
        return generic
    db.query(PasswordResetToken).filter(
        PasswordResetToken.user_id == user.id, PasswordResetToken.used == 0
    ).update({"used": 1})
    raw_token = secrets.token_urlsafe(24)
    db.add(PasswordResetToken(user_id=user.id, token=_token_hash(raw_token),
                              expires_at=datetime.utcnow() + timedelta(hours=1)))
    db.commit()
    delivered = _send_reset_email(user.email, raw_token)
    generic["email_sent"] = delivered
    if APP_ENV != "production" and not delivered:
        # Local development fallback only. Frontend fills the input but never prints the code.
        generic["reset_token"] = raw_token
        logger.warning("Development reset code issued because SMTP is not configured")
    elif APP_ENV == "production" and not delivered:
        logger.error("Reset requested but SMTP delivery is unavailable")
    return generic


@app.post("/auth/reset-password")
def reset_password(data: ResetPasswordSchema, request: Request, db: Session = Depends(get_db)):
    _rate_limit(request, "reset", RESET_RATE_LIMIT, 900)
    rec = db.query(PasswordResetToken).filter(
        PasswordResetToken.token == _token_hash(data.token), PasswordResetToken.used == 0
    ).first()
    if not rec or datetime.utcnow() > rec.expires_at:
        raise HTTPException(400, "Invalid, expired, or already-used reset code")
    user = db.query(User).filter(User.id == rec.user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    user.password = generate_password_hash(data.new_password)
    user.token_version = int(user.token_version or 0) + 1
    rec.used = 1
    db.query(RefreshToken).filter(RefreshToken.user_id == user.id).update({"revoked": 1})
    db.commit()
    return {"status": "success", "message": "Password reset successfully. Please log in."}


# ── USER PROFILE ───────────────────────────────────────────────
def _json_object(raw: Optional[str]) -> dict:
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _clean_profile_payload(value: Optional[Dict]) -> dict:
    if value is None:
        return {}
    allowed = {
        "fullName", "fatherName", "email", "institute", "department",
        "class", "academicId", "phone", "bio", "designation",
        "qualification", "teacherSubject", "teacherAccessCode",
        "teacherCode", "classCode", "activeClassCode", "classCodes",
        "studentClasses"
    }
    cleaned = {}
    for key, item in value.items():
        if key not in allowed:
            continue
        if isinstance(item, list):
            cleaned[key] = [str(x)[:120] for x in item[:100]]
        elif item is None:
            cleaned[key] = ""
        else:
            cleaned[key] = str(item)[:2000]
    return cleaned


def _clean_preferences_payload(value: Optional[Dict]) -> dict:
    if value is None:
        return {}
    allowed = {"theme", "startPage", "compactMode", "notifications"}
    return {k: v for k, v in value.items() if k in allowed}

@app.get("/api/v1/user/{user_id}/profile")
def get_profile(user_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_self(user_id, current_user)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    total_sessions = db.query(QuizSession).filter(QuizSession.user_id == user_id).count()
    total_attempts = db.query(QuizAttempt).filter(QuizAttempt.user_id == user_id).count()
    return {
        "user_id": user.id,
        "username": user.username,
        "email": user.email,
        "avatar_b64": user.avatar_b64,
        "role": user.role or "student",
        "academic_profile": _json_object(user.profile_json),
        "preferences": _json_object(user.preferences_json),
        "member_since": user.created_at.strftime("%d %b %Y"),
        "total_sessions": total_sessions,
        "total_attempts": total_attempts,
    }


@app.patch("/api/v1/user/{user_id}/profile")
def update_profile(user_id: int, data: ProfileUpdateSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_self(user_id, current_user)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    if data.username is not None:
        uname = data.username.strip()
        if len(uname) < 3 or len(uname) > 30 or not re.match(r"^[a-zA-Z0-9_]+$", uname):
            raise HTTPException(400, "Invalid username format")
        existing = db.query(User).filter(User.username == uname, User.id != user_id).first()
        if existing:
            raise HTTPException(400, "Username already taken")
        user.username = uname
    if data.email is not None:
        em = data.email.strip().lower()
        if not re.match(r"^[\w\.-]+@[\w\.-]+\.\w{2,}$", em):
            raise HTTPException(400, "Invalid email format")
        existing = db.query(User).filter(User.email == em, User.id != user_id).first()
        if existing:
            raise HTTPException(400, "Email already registered")
        user.email = em
    if data.avatar_b64 is not None:
        user.avatar_b64 = data.avatar_b64
    if data.academic_profile is not None:
        merged = _json_object(user.profile_json)
        merged.update(_clean_profile_payload(data.academic_profile))
        user.profile_json = json.dumps(merged, ensure_ascii=False)
    if data.preferences is not None:
        merged_prefs = _json_object(user.preferences_json)
        merged_prefs.update(_clean_preferences_payload(data.preferences))
        user.preferences_json = json.dumps(merged_prefs, ensure_ascii=False)
    db.commit()
    db.refresh(user)
    return {
        "status": "success",
        "user_id": user.id,
        "username": user.username,
        "email": user.email,
        "avatar_b64": user.avatar_b64,
        "role": user.role or "student",
        "academic_profile": _json_object(user.profile_json),
        "preferences": _json_object(user.preferences_json),
    }


@app.post("/api/v1/user/{user_id}/change-password")
def change_password(user_id: int, data: PasswordChangeSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_self(user_id, current_user)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    if not check_password_hash(user.password, data.current_password):
        raise HTTPException(401, "Current password is incorrect")
    user.password = generate_password_hash(data.new_password)
    user.token_version = int(user.token_version or 0) + 1
    db.query(RefreshToken).filter(RefreshToken.user_id == user.id).update({"revoked": 1})
    db.commit()
    return {"status": "success", "message": "Password changed successfully. Please sign in again."}


# ── QUIZ GENERATION ────────────────────────────────────────────
@app.post("/api/v1/generate-quiz")
async def generate_quiz(req: QuizRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_self(req.user_id, current_user)
    user = current_user
    if not user:
        raise HTTPException(404, "User not found")
    t0 = time.time()
    try:
        questions = quiz_engine.generate(req.text_content, req.count)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    elapsed = round(time.time() - t0, 3)
    if not questions:
        raise HTTPException(422, "Could not generate questions. Provide more detailed academic text (min 3-5 sentences).")
    session = _persist_session(
        db, req.user_id,
        _clean_session_title(req.quiz_title, f"Quiz_{datetime.now().strftime('%Y%m%d_%H%M%S')}"),
        req.text_content, questions, elapsed, "text",
    )
    return {
        "session_id": session.id,
        "time": f"{elapsed}s",
        "total": len(questions),
        "quiz_type": session.quiz_type,
        "source_type": "text",
        "quiz": questions,
        "stats": _build_stats(questions),
    }


@app.post("/api/v1/generate-quiz-pdf")
async def generate_quiz_from_pdf(
    user_id: int = Form(...),
    count: int = Form(10),
    quiz_title: Optional[str] = Form(None),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_self(user_id, current_user)
    if not PDF_SUPPORT:
        raise HTTPException(500, "PDF support not installed. Run: pip install pymupdf")
    filename = file.filename or "uploaded.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted")
    user = current_user
    if not (1 <= count <= 250):
        raise HTTPException(400, "Count must be 1-250")
    pdf_bytes = await file.read()
    if len(pdf_bytes) > MAX_PDF_BYTES:
        max_mb = round(MAX_PDF_BYTES / (1024 * 1024), 2)
        raise HTTPException(400, f"PDF too large — max {max_mb}MB")
    extracted = extract_text_from_pdf(pdf_bytes)
    if len(extracted) > MAX_TEXT_CHARS:
        extracted = extracted[:MAX_TEXT_CHARS]
    if len(extracted.strip()) < 50:
        raise HTTPException(422, "Could not extract enough text. Make sure the PDF has readable text.")
    quality_ok, quality_error = _pdf_text_quality(extracted)
    if not quality_ok:
        raise HTTPException(422, quality_error)
    t0 = time.time()
    try:
        # PDF quizzes stay strictly grounded in the uploaded document.
        # Questions are built from exact source sentences, not free-form model text.
        questions = quiz_engine.generate(extracted, count, grounded_only=True)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    elapsed = round(time.time() - t0, 3)
    if not questions:
        raise HTTPException(422, "Could not generate questions from PDF.")
    session = _persist_session(
        db, user_id,
        _clean_session_title(quiz_title, f"PDF_{filename[:30]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"),
        extracted, questions, elapsed, "pdf",
    )
    stats = _build_stats(questions)
    stats.update({"pdf_chars": len(extracted), "pdf_file": filename})
    return {
        "session_id": session.id,
        "time": f"{elapsed}s",
        "total": len(questions),
        "quiz_type": session.quiz_type,
        "source_type": "pdf",
        "pdf_filename": filename,
        "quiz": questions,
        "stats": stats,
    }



# ── PHASE 7: PROFESSIONAL QUESTION REVIEW PIPELINE ─────────────
def _question_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()

def _validate_question_payload(row: dict) -> tuple[Optional[dict], list[str]]:
    warnings = []
    question = re.sub(r"\s+", " ", str(row.get("question") or "").strip())
    options = [re.sub(r"\s+", " ", str(x).strip()) for x in (row.get("options") or []) if str(x).strip()]
    correct = str(row.get("correct") or "").strip()
    if len(question) < 12: warnings.append("Question is too short")
    # Deduplicate options while preserving order.
    clean=[]; seen=set()
    for op in options:
        k=_question_key(op)
        if k and k not in seen: clean.append(op); seen.add(k)
    options=clean
    if correct and _question_key(correct) not in {_question_key(x) for x in options}: options.insert(0, correct)
    if len(options) != 4: warnings.append("Question must contain exactly four unique options")
    if len(options) < 4: return None, warnings
    options=options[:4]
    idx=next((i for i,x in enumerate(options) if _question_key(x)==_question_key(correct)), -1)
    if idx < 0: warnings.append("Correct answer is not present in options"); return None, warnings
    if question.endswith("____.") and len(correct.split()) > 7: warnings.append("Answer span may be too long")
    quality=float(row.get("quality_score") or 0.0)
    if quality < 0.55: warnings.append("Low AI quality score")
    return {
        "question": question, "options": options, "correct": options[idx], "correct_index": idx,
        "difficulty": str(row.get("difficulty") or "medium").lower(),
        "topic_cluster": int(row.get("topic_cluster") or 0),
        "quality_score": round(quality,3),
        "question_type": str(row.get("question_type") or "manual"),
        "explanation": str(row.get("explanation") or ""),
    }, warnings

def _dedupe_questions(rows: list[dict]) -> tuple[list[tuple[dict,list[str]]], int]:
    accepted=[]; keys=[]; removed=0
    for row in rows:
        valid,warnings=_validate_question_payload(row)
        if not valid: removed+=1; continue
        key=_question_key(valid["question"])
        duplicate=False
        for old in keys:
            a=set(key.split()); b=set(old.split())
            similarity=len(a&b)/max(1,len(a|b))
            if key==old or similarity>=0.82: duplicate=True; break
        if duplicate: removed+=1; continue
        keys.append(key); accepted.append((valid,warnings))
    return accepted,removed

def _parse_mcq_text(text: str) -> list[dict]:
    text=str(text or "").replace("\r","")
    blocks=re.split(r"\n\s*\n|(?=\n?\s*\d+[.)]\s+)", text)
    out=[]
    for block in blocks:
        lines=[x.strip() for x in block.splitlines() if x.strip()]
        if len(lines)<5: continue
        q=re.sub(r"^\d+[.)]\s*", "", lines[0]).strip()
        opts=[]; answer=None
        for line in lines[1:]:
            m=re.match(r"^([A-Da-d])[.)\-:]\s*(.+)$", line)
            if m: opts.append(m.group(2).strip()); continue
            am=re.match(r"^(?:answer|correct)\s*[:\-]\s*([A-Da-d]|.+)$", line, re.I)
            if am: answer=am.group(1).strip()
        if len(opts)>=4:
            if answer and len(answer)==1 and answer.upper() in "ABCD": correct=opts[ord(answer.upper())-65]
            else: correct=answer or opts[0]
            out.append({"question":q,"options":opts[:4],"correct":correct,"difficulty":"medium","quality_score":1.0,"topic_cluster":0,"question_type":"imported_mcq"})
    return out

def _draft_payload(draft: QuizDraft) -> dict:
    return {"id":draft.id,"title":draft.title,"source_type":draft.source_type,"status":draft.status,
      "requested_count":draft.requested_count,"approved_count":sum(1 for q in draft.questions if q.status=="approved"),
      "warnings":json.loads(draft.warnings_json or "[]"),"created_at":draft.created_at.isoformat(),
      "questions":[{"id":q.id,"position":q.position,"question":q.question_body,"options":json.loads(q.options_json),
      "correct_index":q.correct_index,"correct":json.loads(q.options_json)[q.correct_index],"explanation":q.explanation,
      "difficulty":q.difficulty,"topic_cluster":q.topic_cluster,"quality_score":q.quality_score,"status":q.status,
      "validation":json.loads(q.validation_json or "[]")} for q in draft.questions]}



# ── PHASE 7: AI DRAFT / REVIEW / APPROVAL APIS ─────────────────
@app.post("/api/v1/ai/drafts")
def create_ai_draft(data: DraftCreateSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    content=data.source_content.strip()
    if len(content)<20: raise HTTPException(422,"Provide more source content")
    started=time.time()
    if data.source_type in {"manual_mcq","mcq_text"}: raw=_parse_mcq_text(content)
    else:
        try: raw=quiz_engine.generate(content,data.count)
        except RuntimeError as exc: raise HTTPException(503,str(exc))
    checked,duplicates=_dedupe_questions(raw)
    if not checked: raise HTTPException(422,"No valid questions were produced. Review the source format and try again.")
    warnings=[]
    if duplicates: warnings.append(f"Removed {duplicates} invalid or duplicate questions")
    if len(checked)<data.count: warnings.append(f"Generated {len(checked)} reviewable questions from {data.count} requested")
    draft=QuizDraft(owner_id=current_user.id,title=_clean_session_title(data.title,"Quiz review draft"),source_type=data.source_type,
      source_content=content[:MAX_TEXT_CHARS],requested_count=data.count,status="review",warnings_json=json.dumps(warnings))
    db.add(draft); db.flush()
    for pos,(row,validation) in enumerate(checked,1):
        status="approved" if not validation and row["quality_score"]>=data.auto_approve_quality else "pending"
        db.add(QuizDraftQuestion(draft_id=draft.id,position=pos,question_body=row["question"],options_json=json.dumps(row["options"]),
          correct_index=row["correct_index"],explanation=row.get("explanation","") or "",difficulty=row["difficulty"],
          topic_cluster=row["topic_cluster"],quality_score=row["quality_score"],status=status,validation_json=json.dumps(validation)))
    db.commit(); db.refresh(draft)
    payload=_draft_payload(draft); payload["processing_time"]=round(time.time()-started,3)
    return payload

@app.post("/api/v1/ai/drafts/pdf")
async def create_pdf_ai_draft(
    file: UploadFile = File(...), count: int = Form(10), title: str = Form("PDF review draft"),
    auto_approve_quality: float = Form(0.72), current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    if not PDF_SUPPORT: raise HTTPException(503,"PDF support is not installed")
    filename=file.filename or "document.pdf"
    raw=await file.read()
    if len(raw)>MAX_PDF_BYTES: raise HTTPException(413,"PDF exceeds the configured upload limit")
    if not raw.startswith(b"%PDF-"): raise HTTPException(400,"The uploaded file is not a valid PDF")
    if not 1<=count<=100: raise HTTPException(422,"Professional review drafts support 1-100 questions")
    extracted=extract_text_from_pdf(raw)
    if len(extracted.strip())<50: raise HTTPException(422,"No readable PDF text was found. Scanned PDFs require OCR.")
    started=time.time()
    try: generated=quiz_engine.generate(extracted,count)
    except RuntimeError as exc: raise HTTPException(503,str(exc))
    checked,duplicates=_dedupe_questions(generated)
    if not checked: raise HTTPException(422,"No valid reviewable questions could be generated from this PDF")
    warnings=[]
    if len(extracted)>=MAX_TEXT_CHARS: warnings.append("PDF text reached the configured processing limit and may have been truncated")
    if duplicates: warnings.append(f"Removed {duplicates} invalid or duplicate questions")
    if len(checked)<count: warnings.append(f"Generated {len(checked)} reviewable questions from {count} requested")
    draft=QuizDraft(owner_id=current_user.id,title=_clean_session_title(title,filename),source_type="pdf",source_content=extracted[:MAX_TEXT_CHARS],
      requested_count=count,status="review",warnings_json=json.dumps(warnings))
    db.add(draft);db.flush()
    for pos,(row,validation) in enumerate(checked,1):
        status="approved" if not validation and row["quality_score"]>=auto_approve_quality else "pending"
        db.add(QuizDraftQuestion(draft_id=draft.id,position=pos,question_body=row["question"],options_json=json.dumps(row["options"]),
          correct_index=row["correct_index"],explanation=row.get("explanation","") or "",difficulty=row["difficulty"],topic_cluster=row["topic_cluster"],
          quality_score=row["quality_score"],status=status,validation_json=json.dumps(validation)))
    db.commit();db.refresh(draft);payload=_draft_payload(draft);payload.update({"processing_time":round(time.time()-started,3),"pdf_filename":filename});return payload

@app.get("/api/v1/ai/drafts")
def list_ai_drafts(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows=db.query(QuizDraft).filter(QuizDraft.owner_id==current_user.id).order_by(QuizDraft.updated_at.desc()).limit(50).all()
    return [{"id":x.id,"title":x.title,"status":x.status,"source_type":x.source_type,"requested_count":x.requested_count,
      "question_count":len(x.questions),"approved_count":sum(1 for q in x.questions if q.status=="approved"),"updated_at":x.updated_at.isoformat()} for x in rows]

@app.get("/api/v1/ai/drafts/{draft_id}")
def get_ai_draft(draft_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    draft=db.query(QuizDraft).filter(QuizDraft.id==draft_id,QuizDraft.owner_id==current_user.id).first()
    if not draft: raise HTTPException(404,"Draft not found")
    return _draft_payload(draft)

@app.patch("/api/v1/ai/drafts/{draft_id}/questions/{question_id}")
def update_draft_question(draft_id:int,question_id:int,data:DraftQuestionUpdateSchema,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    draft=db.query(QuizDraft).filter(QuizDraft.id==draft_id,QuizDraft.owner_id==current_user.id).first()
    if not draft or draft.status=="finalized": raise HTTPException(404,"Editable draft not found")
    q=db.query(QuizDraftQuestion).filter(QuizDraftQuestion.id==question_id,QuizDraftQuestion.draft_id==draft.id).first()
    if not q: raise HTTPException(404,"Question not found")
    options=json.loads(q.options_json); correct_index=q.correct_index
    if data.question is not None: q.question_body=re.sub(r"\s+"," ",data.question.strip())
    if data.options is not None: options=[re.sub(r"\s+"," ",str(x).strip()) for x in data.options]
    if data.correct_index is not None: correct_index=data.correct_index
    candidate={"question":q.question_body,"options":options,"correct":options[correct_index] if 0<=correct_index<len(options) else "",
      "quality_score":q.quality_score,"difficulty":data.difficulty or q.difficulty,"topic_cluster":q.topic_cluster}
    valid,warnings=_validate_question_payload(candidate)
    if not valid: raise HTTPException(422,{"message":"Question validation failed","warnings":warnings})
    q.question_body=valid["question"]; q.options_json=json.dumps(valid["options"]); q.correct_index=valid["correct_index"]
    if data.explanation is not None:q.explanation=data.explanation.strip()
    if data.difficulty is not None:q.difficulty=data.difficulty.lower()
    if data.status is not None:
        if data.status not in {"pending","approved","rejected"}:raise HTTPException(422,"Invalid review status")
        q.status=data.status
    if data.position is not None:q.position=max(1,data.position)
    q.validation_json=json.dumps(warnings); draft.updated_at=datetime.utcnow(); db.commit();db.refresh(draft)
    return _draft_payload(draft)

@app.delete("/api/v1/ai/drafts/{draft_id}/questions/{question_id}")
def delete_draft_question(draft_id:int,question_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    draft=db.query(QuizDraft).filter(QuizDraft.id==draft_id,QuizDraft.owner_id==current_user.id).first()
    if not draft or draft.status=="finalized":raise HTTPException(404,"Editable draft not found")
    q=db.query(QuizDraftQuestion).filter(QuizDraftQuestion.id==question_id,QuizDraftQuestion.draft_id==draft.id).first()
    if not q:raise HTTPException(404,"Question not found")
    db.delete(q);db.flush()
    for pos,row in enumerate(db.query(QuizDraftQuestion).filter(QuizDraftQuestion.draft_id==draft.id).order_by(QuizDraftQuestion.position).all(),1):row.position=pos
    draft.updated_at=datetime.utcnow();db.commit();return {"status":"deleted"}

@app.post("/api/v1/ai/drafts/{draft_id}/finalize")
def finalize_ai_draft(draft_id:int,data:DraftFinalizeSchema,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    draft=db.query(QuizDraft).filter(QuizDraft.id==draft_id,QuizDraft.owner_id==current_user.id).first()
    if not draft:raise HTTPException(404,"Draft not found")
    selected=[q for q in draft.questions if (q.status=="approved" or not data.approved_only) and q.status!="rejected"]
    if not selected:raise HTTPException(422,"Approve at least one question before finalizing")
    questions=[]
    for q in selected:
        ops=json.loads(q.options_json)
        questions.append({"question":q.question_body,"options":ops,"correct":ops[q.correct_index],"difficulty":q.difficulty,
          "topic_cluster":q.topic_cluster,"quality_score":q.quality_score,"question_type":"reviewed_ai"})
    session=_persist_session(db,current_user.id,_clean_session_title(data.title or draft.title,"Reviewed quiz"),draft.source_content,questions,0.0,draft.source_type)
    draft.status="finalized";draft.approved_count=len(selected);draft.updated_at=datetime.utcnow();db.commit()
    return {"session_id":session.id,"total":len(questions),"quiz":questions,"stats":_build_stats(questions),"draft_id":draft.id,"reviewed":True}


# ── HISTORY / SESSIONS ─────────────────────────────────────────
@app.get("/api/v1/history/{user_id}")
def get_history(user_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_self(user_id, current_user)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    sessions = (
        db.query(QuizSession)
        .filter(QuizSession.user_id == user_id)
        .order_by(QuizSession.created_at.desc())
        .limit(100)
        .all()
    )
    result = []
    for s in sessions:
        last_attempt = (
            db.query(QuizAttempt)
            .filter(QuizAttempt.session_id == s.id)
            .order_by(QuizAttempt.attempted_at.desc())
            .first()
        )
        result.append({
            "session_id": s.id,
            "title": s.title,
            "total_questions": s.total_questions,
            "quiz_type": s.quiz_type,
            "source_type": s.source_type or "text",
            "processing_time": f"{s.processing_time}s",
            "created_at": s.created_at.strftime("%d %b %Y %H:%M"),
            "last_score": last_attempt.pct if last_attempt else None,
            "attempt_count": db.query(QuizAttempt).filter(QuizAttempt.session_id == s.id).count(),
        })
    return {"user": user.username, "total_sessions": len(sessions), "sessions": result}


@app.get("/api/v1/session/{session_id}")
def get_session(session_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    session = db.query(QuizSession).filter(QuizSession.id == session_id, QuizSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(404, "Session not found")
    questions = db.query(QuestionBank).filter(QuestionBank.session_id == session_id).all()
    return {
        "session_id": session_id,
        "title": session.title,
        "source_type": session.source_type or "text",
        "quiz_type": session.quiz_type,
        "total": len(questions),
        "questions": _serialize_questions(questions),
    }


@app.patch("/api/v1/session/{session_id}/title")
def rename_session(session_id: int, data: RenameSessionSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_self(data.user_id, current_user)
    session = db.query(QuizSession).filter(
        QuizSession.id == session_id, QuizSession.user_id == data.user_id
    ).first()
    if not session:
        raise HTTPException(404, "Session not found or not yours")
    session.title = data.title
    db.commit()
    db.refresh(session)
    return {"status": "success", "session_id": session.id, "title": session.title}


@app.delete("/api/v1/session/{session_id}")
def delete_session(session_id: int, user_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_self(user_id, current_user)
    session = db.query(QuizSession).filter(
        QuizSession.id == session_id, QuizSession.user_id == user_id
    ).first()
    if not session:
        raise HTTPException(404, "Session not found or not yours")
    db.delete(session)
    db.commit()
    return {"status": "success", "message": "Quiz deleted"}


# ── ATTEMPTS ───────────────────────────────────────────────────
@app.post("/api/v1/session/{session_id}/attempt")
def save_attempt(session_id: int, data: AttemptSaveSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_self(data.user_id, current_user)
    session = db.query(QuizSession).filter(QuizSession.id == session_id).first()
    if not session:
        raise HTTPException(404, "Session not found")
    if session.user_id != data.user_id:
        raise HTTPException(403, "This quiz session does not belong to this user")

    question_count = db.query(QuestionBank).filter(QuestionBank.session_id == session_id).count()
    if question_count and data.total != question_count:
        raise HTTPException(400, "Attempt total does not match this quiz session")

    questions = db.query(QuestionBank).filter(QuestionBank.session_id == session_id).order_by(QuestionBank.id.asc()).all()
    verified_score = 0
    normalized_answers = {}
    for idx, q in enumerate(questions):
        raw_choice = data.answers.get(str(idx), data.answers.get(str(q.id)))
        if raw_choice is None:
            continue
        try:
            choice = int(raw_choice)
        except (TypeError, ValueError):
            raise HTTPException(400, "Invalid answer selection")
        options = q.distractors_json.split("|") if q.distractors_json else []
        if choice < 0 or choice >= len(options):
            raise HTTPException(400, "Answer selection is outside the available options")
        normalized_answers[str(q.id)] = choice
        if options[choice] == q.correct_ans:
            verified_score += 1
    pct = round((verified_score / data.total * 100), 1)
    attempt = QuizAttempt(
        session_id=session_id,
        user_id=current_user.id,
        score=verified_score,
        total=data.total,
        pct=pct,
        answers_json=json.dumps(normalized_answers),
    )
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    revision_questions=[]
    for q in questions:
        opts=q.distractors_json.split("|") if q.distractors_json else []
        chosen=normalized_answers.get(str(q.id))
        revision_questions.append({"question":q.question_body,"options":opts,"correctAnswer":q.correct_ans,"selectedAnswer":opts[chosen] if chosen is not None and 0 <= chosen < len(opts) else None,"correct":chosen is not None and opts[chosen]==q.correct_ans,"difficulty":q.difficulty or "medium"})
    _upsert_revision_item(db,current_user.id,"personal_quiz",session_id,session.title or "Personal quiz",pct,revision_questions)
    return {
        "status": "success",
        "attempt_id": attempt.id,
        "score": verified_score,
        "total": data.total,
        "pct": pct,
        "attempted_at": attempt.attempted_at.strftime("%d %b %Y %H:%M"),
    }


@app.get("/api/v1/session/{session_id}/attempts")
def get_attempts(session_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    session = db.query(QuizSession).filter(QuizSession.id == session_id, QuizSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(404, "Session not found")
    attempts = (
        db.query(QuizAttempt)
        .filter(QuizAttempt.session_id == session_id)
        .order_by(QuizAttempt.attempted_at.asc())
        .all()
    )
    data = [
        {
            "attempt_num": i + 1,
            "attempt_id": a.id,
            "score": a.score,
            "total": a.total,
            "pct": a.pct,
            "attempted_at": a.attempted_at.strftime("%d %b %Y %H:%M"),
        }
        for i, a in enumerate(attempts)
    ]
    # Compute improvement: compare first vs latest attempt
    improvement = None
    if len(data) >= 2:
        improvement = round(data[-1]["pct"] - data[0]["pct"], 1)
    return {
        "session_id": session_id,
        "title": session.title,
        "total_attempts": len(data),
        "best_pct": max((a["pct"] for a in data), default=None),
        "improvement": improvement,
        "attempts": data,
    }


# ── ML INFO ────────────────────────────────────────────────────
@app.get("/api/v1/classes/mine")
def list_my_classes(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if (current_user.role or "student") == "teacher":
        rows = db.query(Classroom).filter(Classroom.teacher_id == current_user.id, Classroom.is_active == 1).order_by(Classroom.created_at.asc()).all()
        return {"teacherCode": _teacher_code_for(db, current_user.id), "classes": [_class_payload(c, db, True) for c in rows]}
    memberships = db.query(ClassMember).filter(ClassMember.student_id == current_user.id, ClassMember.status == "active").all()
    return {"studentCode": _student_code(current_user), "classes": [_class_payload(m.classroom, db, False) for m in memberships if m.classroom.is_active]}


@app.post("/api/v1/classes")
def create_class(data: ClassCreateSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_teacher(current_user)
    raw_key = data.class_key or secrets.token_hex(2).upper()
    c = Classroom(teacher_id=current_user.id, teacher_code=_teacher_code_for(db, current_user.id),
        class_code=_new_unique_code(db, "CLS", Classroom.class_code), class_key_hash=generate_password_hash(raw_key),
        class_key_hint=raw_key, name=data.name, subject=(data.subject or "General").strip()[:120], section=(data.section or "").strip()[:80])
    db.add(c); db.commit(); db.refresh(c)
    return _class_payload(c, db, True)


@app.patch("/api/v1/classes/{class_id}")
def update_class(class_id: int, data: ClassUpdateSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_teacher(current_user)
    c = db.query(Classroom).filter(Classroom.id == class_id, Classroom.teacher_id == current_user.id, Classroom.is_active == 1).first()
    if not c: raise HTTPException(404, "Class not found")
    if data.name is not None: c.name = re.sub(r"\s+", " ", data.name.strip())[:120]
    if data.subject is not None: c.subject = data.subject.strip()[:120] or "General"
    if data.section is not None: c.section = data.section.strip()[:80]
    if data.class_key is not None:
        key = re.sub(r"[^A-Za-z0-9]", "", data.class_key).upper()
        if not 4 <= len(key) <= 12: raise HTTPException(422, "Class key must be 4-12 letters/numbers")
        c.class_key_hash = generate_password_hash(key); c.class_key_hint = key
    c.updated_at = datetime.utcnow(); db.commit(); db.refresh(c)
    return _class_payload(c, db, True)


@app.delete("/api/v1/classes/{class_id}")
def delete_class(class_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_teacher(current_user)
    c = db.query(Classroom).filter(Classroom.id == class_id, Classroom.teacher_id == current_user.id, Classroom.is_active == 1).first()
    if not c: raise HTTPException(404, "Class not found")
    c.is_active = 0; c.updated_at = datetime.utcnow(); db.commit()
    return {"status": "success"}


@app.get("/api/v1/classes/discover/{code}")
def discover_classes(code: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    code = code.strip().upper()
    q = db.query(Classroom).filter(Classroom.is_active == 1)
    rows = q.filter(Classroom.teacher_code == code).all() if code.startswith("TCH-") else q.filter(Classroom.class_code == code).all()
    return {"classes": [_class_payload(c, db, False) for c in rows]}


@app.post("/api/v1/classes/join")
def join_class(data: ClassJoinSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if (current_user.role or "student") != "student": raise HTTPException(403, "Only students can join classes")
    code = data.code.strip().upper()
    c = db.query(Classroom).filter(Classroom.class_code == code, Classroom.is_active == 1).first()
    if not c: raise HTTPException(404, "Class not found")
    existing = db.query(ClassMember).filter(ClassMember.class_id == c.id, ClassMember.student_id == current_user.id).first()
    if existing:
        existing.status = "active"; db.commit(); return _class_payload(c, db, False)
    student_code, email = _student_code(current_user).upper(), current_user.email.lower()
    approved = db.query(ClassApproval).filter(ClassApproval.class_id == c.id, ClassApproval.approval_value.in_([student_code, email])).first()
    key_ok = bool(data.class_key and check_password_hash(c.class_key_hash, re.sub(r"[^A-Za-z0-9]", "", data.class_key).upper()))
    if not approved and not key_ok: raise HTTPException(403, "Correct class key or teacher approval is required")
    db.add(ClassMember(class_id=c.id, student_id=current_user.id, join_method="teacher-approved" if approved else "class-key")); db.commit()
    return _class_payload(c, db, False)


@app.post("/api/v1/classes/{class_id}/leave")
def leave_class(class_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    m = db.query(ClassMember).filter(ClassMember.class_id == class_id, ClassMember.student_id == current_user.id).first()
    if not m: raise HTTPException(404, "Membership not found")
    m.status = "left"; db.commit(); return {"status": "success"}


@app.post("/api/v1/classes/{class_id}/approvals")
def add_class_approval(class_id: int, data: ClassApprovalSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_teacher(current_user)
    c = db.query(Classroom).filter(Classroom.id == class_id, Classroom.teacher_id == current_user.id, Classroom.is_active == 1).first()
    if not c: raise HTTPException(404, "Class not found")
    raw = data.value.strip(); typ = "email" if "@" in raw else "student_code"; value = raw.lower() if typ == "email" else raw.upper()
    if not value: raise HTTPException(422, "Approval value required")
    if not db.query(ClassApproval).filter(ClassApproval.class_id == c.id, ClassApproval.approval_value == value).first():
        db.add(ClassApproval(class_id=c.id, approval_type=typ, approval_value=value)); db.commit()
    return _class_payload(c, db, True)


@app.delete("/api/v1/classes/{class_id}/approvals/{value}")
def remove_class_approval(class_id: int, value: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_teacher(current_user)
    c = db.query(Classroom).filter(Classroom.id == class_id, Classroom.teacher_id == current_user.id).first()
    if not c: raise HTTPException(404, "Class not found")
    decoded = value.strip(); row = db.query(ClassApproval).filter(ClassApproval.class_id == c.id, ClassApproval.approval_value.in_([decoded, decoded.upper(), decoded.lower()])).first()
    if row: db.delete(row); db.commit()
    return _class_payload(c, db, True)


@app.delete("/api/v1/classes/{class_id}/members/{student_id}")
def remove_class_member(class_id: int, student_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_teacher(current_user)
    c = db.query(Classroom).filter(Classroom.id == class_id, Classroom.teacher_id == current_user.id).first()
    if not c: raise HTTPException(404, "Class not found")
    m = db.query(ClassMember).filter(ClassMember.class_id == c.id, ClassMember.student_id == student_id).first()
    if not m: raise HTTPException(404, "Student not found in class")
    m.status = "removed"; db.commit(); return {"status": "success"}


@app.get("/api/v1/assignments/mine")
def list_my_assignments(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if (current_user.role or "student") == "teacher":
        rows = db.query(Assignment).filter(Assignment.teacher_id == current_user.id).order_by(Assignment.created_at.desc()).all()
        return {"assignments": [_assignment_payload(a, db) for a in rows]}
    memberships = db.query(ClassMember).filter(ClassMember.student_id == current_user.id, ClassMember.status == "active").all()
    class_ids = [m.class_id for m in memberships]
    if not class_ids:
        return {"assignments": []}
    rows = db.query(Assignment).filter(Assignment.class_id.in_(class_ids), Assignment.status == "published").order_by(Assignment.created_at.desc()).all()
    visible = []
    now = datetime.utcnow()
    for a in rows:
        targets = [t.student_id for t in a.targets]
        if targets and current_user.id not in targets:
            continue
        if a.closed_at and a.closed_at <= now:
            continue
        visible.append(_assignment_payload(a, db))
    return {"assignments": visible}


@app.post("/api/v1/assignments")
def create_assignment(data: AssignmentCreateSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_teacher(current_user)
    c = db.query(Classroom).filter(Classroom.id == data.class_id, Classroom.teacher_id == current_user.id, Classroom.is_active == 1).first()
    if not c:
        raise HTTPException(404, "Class not found")
    member_ids = {m.student_id for m in db.query(ClassMember).filter(ClassMember.class_id == c.id, ClassMember.status == "active").all()}
    targets = list(dict.fromkeys(data.target_student_ids or []))
    if any(student_id not in member_ids for student_id in targets):
        raise HTTPException(422, "Every selected student must be an active member of this class")
    now = datetime.utcnow()
    a = Assignment(class_id=c.id, teacher_id=current_user.id, title=data.title,
        subject=(data.subject or c.subject or "General").strip()[:120], instructions=(data.instructions or "").strip(),
        source_type=(data.source_type or "create").strip()[:30], source_content=data.source_content or "",
        question_count=data.question_count, time_limit_minutes=data.time_limit_minutes,
        allow_retake=1 if data.allow_retake else 0, status=data.status, due_at=data.due_at,
        published_at=now if data.status == "published" else None, closed_at=now if data.status == "closed" else None)
    db.add(a); db.flush()
    for student_id in targets:
        db.add(AssignmentTarget(assignment_id=a.id, student_id=student_id))
    for position, q in enumerate(data.questions or []):
        options = q.get("options") if isinstance(q, dict) else None
        if not isinstance(options, list) or len(options) < 2:
            continue
        correct_index = q.get("correct_index", 0)
        if not isinstance(correct_index, int) or not 0 <= correct_index < len(options):
            correct = str(q.get("correct", ""))
            correct_index = options.index(correct) if correct in options else 0
        db.add(AssignmentQuestion(assignment_id=a.id, position=position, question_body=str(q.get("question", "Question")).strip(), options_json=json.dumps([str(x) for x in options]), correct_index=correct_index, explanation=str(q.get("explanation", ""))))
    db.commit(); db.refresh(a)
    return _assignment_payload(a, db)


@app.get("/api/v1/assignments/{assignment_id}")
def get_assignment(assignment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    a = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    if current_user.id != a.teacher_id:
        membership = db.query(ClassMember).filter(ClassMember.class_id == a.class_id, ClassMember.student_id == current_user.id, ClassMember.status == "active").first()
        targets = [t.student_id for t in a.targets]
        if not membership or a.status != "published" or (targets and current_user.id not in targets):
            raise HTTPException(403, "You cannot access this assignment")
    return _assignment_payload(a, db)


@app.patch("/api/v1/assignments/{assignment_id}")
def update_assignment(assignment_id: int, data: AssignmentUpdateSchema, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    a = _teacher_assignment(db, assignment_id, current_user)
    for field in ("title", "subject", "instructions", "source_type", "source_content"):
        value = getattr(data, field)
        if value is not None:
            setattr(a, field, value.strip() if isinstance(value, str) else value)
    if data.question_count is not None:
        if not 1 <= data.question_count <= 250: raise HTTPException(422, "Question count must be 1-250")
        a.question_count = data.question_count
    if data.time_limit_minutes is not None:
        if not 0 <= data.time_limit_minutes <= 300: raise HTTPException(422, "Time limit must be 0-300")
        a.time_limit_minutes = data.time_limit_minutes
    if data.allow_retake is not None: a.allow_retake = 1 if data.allow_retake else 0
    if data.due_at is not None: a.due_at = data.due_at
    if data.status is not None:
        status = data.status.strip().lower()
        if status not in {"draft", "published", "closed"}: raise HTTPException(422, "Invalid assignment status")
        a.status = status
        if status == "published" and not a.published_at: a.published_at = datetime.utcnow()
        a.closed_at = datetime.utcnow() if status == "closed" else None
    if data.target_student_ids is not None:
        member_ids = {m.student_id for m in db.query(ClassMember).filter(ClassMember.class_id == a.class_id, ClassMember.status == "active").all()}
        targets = list(dict.fromkeys(data.target_student_ids))
        if any(student_id not in member_ids for student_id in targets): raise HTTPException(422, "Selected student is not in this class")
        db.query(AssignmentTarget).filter(AssignmentTarget.assignment_id == a.id).delete(synchronize_session=False)
        for student_id in targets: db.add(AssignmentTarget(assignment_id=a.id, student_id=student_id))
    if data.questions is not None:
        db.query(AssignmentQuestion).filter(AssignmentQuestion.assignment_id == a.id).delete(synchronize_session=False)
        for position, q in enumerate(data.questions):
            options = q.get("options") if isinstance(q, dict) else None
            if not isinstance(options, list) or len(options) < 2: continue
            correct_index = q.get("correct_index", 0)
            if not isinstance(correct_index, int) or not 0 <= correct_index < len(options):
                correct = str(q.get("correct", "")); correct_index = options.index(correct) if correct in options else 0
            db.add(AssignmentQuestion(assignment_id=a.id, position=position, question_body=str(q.get("question", "Question")).strip(), options_json=json.dumps([str(x) for x in options]), correct_index=correct_index, explanation=str(q.get("explanation", ""))))
    a.updated_at = datetime.utcnow(); db.commit(); db.refresh(a)
    return _assignment_payload(a, db)


@app.post("/api/v1/assignments/{assignment_id}/publish")
def publish_assignment(assignment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    a = _teacher_assignment(db, assignment_id, current_user); a.status = "published"; a.published_at = a.published_at or datetime.utcnow(); a.closed_at = None; a.updated_at = datetime.utcnow(); db.commit(); db.refresh(a); return _assignment_payload(a, db)


@app.post("/api/v1/assignments/{assignment_id}/close")
def close_assignment(assignment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    a = _teacher_assignment(db, assignment_id, current_user); a.status = "closed"; a.closed_at = datetime.utcnow(); a.updated_at = datetime.utcnow(); db.commit(); db.refresh(a); return _assignment_payload(a, db)


@app.delete("/api/v1/assignments/{assignment_id}")
def delete_assignment(assignment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    a = _teacher_assignment(db, assignment_id, current_user); db.delete(a); db.commit(); return {"status": "success"}


def _student_assignment_access(db: Session, assignment_id: int, user: User) -> Assignment:
    if (user.role or "student") != "student": raise HTTPException(403, "Student account required")
    a = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not a: raise HTTPException(404, "Assignment not found")
    membership = db.query(ClassMember).filter(ClassMember.class_id == a.class_id, ClassMember.student_id == user.id, ClassMember.status == "active").first()
    targets = [t.student_id for t in a.targets]
    if not membership or (targets and user.id not in targets): raise HTTPException(403, "You cannot access this assignment")
    return a


def _attempt_payload(attempt: AssignmentAttempt, a: Assignment, include_answers: bool = True) -> dict:
    remaining = None if not attempt.expires_at else max(0, int((attempt.expires_at-datetime.utcnow()).total_seconds()))
    data = {"attempt_id":attempt.id,"assignment_id":a.id,"attempt_no":attempt.attempt_no,"status":attempt.status,"started_at":attempt.started_at.isoformat(),"expires_at":attempt.expires_at.isoformat() if attempt.expires_at else None,"remaining_seconds":remaining,"score":attempt.score,"total":attempt.total,"answered_count":attempt.answered_count,"submitted_at":attempt.submitted_at.isoformat() if attempt.submitted_at else None}
    if include_answers:
        try: data["answers"] = json.loads(attempt.answers_json or "{}")
        except Exception: data["answers"] = {}
    return data


def _grade_assignment_attempt(db: Session, a: Assignment, attempt: AssignmentAttempt, answers: dict) -> dict:
    questions = db.query(AssignmentQuestion).filter(AssignmentQuestion.assignment_id == a.id).order_by(AssignmentQuestion.position).all()
    clean, review, score = {}, [], 0
    for q in questions:
        raw = answers.get(str(q.id), answers.get(str(q.position)))
        try: chosen = int(raw)
        except Exception: chosen = None
        opts = json.loads(q.options_json or "[]")
        if chosen is not None and 0 <= chosen < len(opts): clean[str(q.id)] = chosen
        correct = chosen == q.correct_index
        if correct: score += 1
        review.append({"question_id":q.id,"position":q.position,"chosen_index":chosen,"correct_index":q.correct_index,"correct":correct,"explanation":q.explanation})
    attempt.answers_json=json.dumps(clean); attempt.answered_count=len(clean); attempt.score=score; attempt.total=len(questions); attempt.status="submitted"; attempt.submitted_at=datetime.utcnow()
    db.commit(); db.refresh(attempt)
    pct = round(score/len(questions)*100) if questions else 0
    revision_questions=[]
    for q,r in zip(questions,review):
        opts=json.loads(q.options_json or "[]")
        revision_questions.append({"question":q.question_body,"options":opts,"correctAnswer":opts[q.correct_index] if 0 <= q.correct_index < len(opts) else "","selectedAnswer":opts[r["chosen_index"]] if r["chosen_index"] is not None and 0 <= r["chosen_index"] < len(opts) else None,"correct":r["correct"],"difficulty":"medium","explanation":q.explanation})
    _upsert_revision_item(db,attempt.student_id,"assignment",a.id,a.title,pct,revision_questions)
    return {"score":score,"total":len(questions),"pct":pct,"answered":len(clean),"wrong":sum(1 for r in review if r["chosen_index"] is not None and not r["correct"]),"skipped":sum(1 for r in review if r["chosen_index"] is None),"review":review}


@app.post("/api/v1/assignments/{assignment_id}/attempts/start")
def start_assignment_attempt(assignment_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    a=_student_assignment_access(db,assignment_id,current_user); now=datetime.utcnow()
    if a.status != "published": raise HTTPException(409,"Assignment is not open")
    if a.due_at and now > a.due_at: raise HTTPException(409,"Assignment due date has passed")
    active=db.query(AssignmentAttempt).filter(AssignmentAttempt.assignment_id==a.id,AssignmentAttempt.student_id==current_user.id,AssignmentAttempt.status=="in_progress").order_by(AssignmentAttempt.id.desc()).first()
    if active and active.expires_at and now >= active.expires_at:
        try: old_answers=json.loads(active.answers_json or "{}")
        except Exception: old_answers={}
        _grade_assignment_attempt(db,a,active,old_answers); active=None
    if active: attempt=active
    else:
        submitted=db.query(AssignmentAttempt).filter(AssignmentAttempt.assignment_id==a.id,AssignmentAttempt.student_id==current_user.id,AssignmentAttempt.status=="submitted").count()
        if submitted and not a.allow_retake: raise HTTPException(409,"This assignment allows only one attempt")
        attempt=AssignmentAttempt(assignment_id=a.id,student_id=current_user.id,attempt_no=submitted+1,status="in_progress",started_at=now,expires_at=now+timedelta(minutes=a.time_limit_minutes) if a.time_limit_minutes else None)
        db.add(attempt); db.commit(); db.refresh(attempt)
    qs=db.query(AssignmentQuestion).filter(AssignmentQuestion.assignment_id==a.id).order_by(AssignmentQuestion.position).all()
    return {"attempt":_attempt_payload(attempt,a),"assignment":_assignment_payload(a,db,False),"questions":[{"id":q.id,"position":q.position,"question":q.question_body,"options":json.loads(q.options_json),"difficulty":"medium"} for q in qs]}


@app.patch("/api/v1/assignment-attempts/{attempt_id}/answers")
def autosave_assignment_answers(attempt_id:int,data:AssignmentAnswerSaveSchema,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    at=db.query(AssignmentAttempt).filter(AssignmentAttempt.id==attempt_id,AssignmentAttempt.student_id==current_user.id).first()
    if not at: raise HTTPException(404,"Attempt not found")
    if at.status!="in_progress": raise HTTPException(409,"Attempt already submitted")
    a=db.query(Assignment).filter(Assignment.id==at.assignment_id).first()
    if at.expires_at and datetime.utcnow()>=at.expires_at:
        return {"expired":True,"result":_grade_assignment_attempt(db,a,at,data.answers),"attempt":_attempt_payload(at,a)}
    valid_ids={str(q.id) for q in db.query(AssignmentQuestion).filter(AssignmentQuestion.assignment_id==a.id).all()}
    clean={str(k):int(v) for k,v in data.answers.items() if str(k) in valid_ids and isinstance(v,int)}
    at.answers_json=json.dumps(clean); at.answered_count=len(clean); db.commit(); db.refresh(at)
    return {"status":"saved","attempt":_attempt_payload(at,a)}


@app.post("/api/v1/assignment-attempts/{attempt_id}/submit")
def submit_assignment_attempt(attempt_id:int,data:AssignmentSubmitSchema,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    at=db.query(AssignmentAttempt).filter(AssignmentAttempt.id==attempt_id,AssignmentAttempt.student_id==current_user.id).first()
    if not at: raise HTTPException(404,"Attempt not found")
    a=_student_assignment_access(db,at.assignment_id,current_user)
    if at.status=="submitted": return {"attempt":_attempt_payload(at,a),"already_submitted":True}
    return {"attempt":_attempt_payload(at,a),"result":_grade_assignment_attempt(db,a,at,data.answers)}


@app.get("/api/v1/assignments/{assignment_id}/attempts/mine")
def my_assignment_attempts(assignment_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    a=_student_assignment_access(db,assignment_id,current_user)
    rows=db.query(AssignmentAttempt).filter(AssignmentAttempt.assignment_id==a.id,AssignmentAttempt.student_id==current_user.id).order_by(AssignmentAttempt.attempt_no.desc()).all()
    return {"attempts":[_attempt_payload(x,a,False) for x in rows]}


@app.get("/api/v1/assignments/{assignment_id}/submissions")
def teacher_assignment_submissions(assignment_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    a=_teacher_assignment(db,assignment_id,current_user)
    rows=db.query(AssignmentAttempt).filter(AssignmentAttempt.assignment_id==a.id,AssignmentAttempt.status=="submitted").order_by(AssignmentAttempt.submitted_at.desc()).all()
    return {"submissions":[{**_attempt_payload(x,a,False),"studentUserId":x.student_id,"studentName":x.student.username,"studentEmail":x.student.email,"pct":round((x.score or 0)/(x.total or 1)*100),"submittedAt":x.submitted_at.isoformat() if x.submitted_at else None} for x in rows]}


# ════════════════════════════════════════════════════════════════
# PHASE 5 — DATABASE-BACKED TEACHER ANALYTICS & REPORTS
# ════════════════════════════════════════════════════════════════
def _latest_submitted_attempts(db: Session, assignment_id: int) -> dict:
    """Return the latest submitted attempt per student for one assignment."""
    rows = (db.query(AssignmentAttempt)
            .filter(AssignmentAttempt.assignment_id == assignment_id,
                    AssignmentAttempt.status == "submitted")
            .order_by(AssignmentAttempt.student_id, AssignmentAttempt.attempt_no.desc(), AssignmentAttempt.id.desc())
            .all())
    latest = {}
    for row in rows:
        latest.setdefault(row.student_id, row)
    return latest


def _assignment_roster(db: Session, assignment: Assignment) -> list:
    """Resolve whole-class or targeted assignment roster using active memberships."""
    active_members = (db.query(ClassMember)
                      .filter(ClassMember.class_id == assignment.class_id,
                              ClassMember.status == "active")
                      .all())
    target_ids = {t.student_id for t in assignment.targets}
    if target_ids:
        active_members = [m for m in active_members if m.student_id in target_ids]
    return active_members


def _assignment_analytics_payload(db: Session, assignment: Assignment, include_questions: bool = True) -> dict:
    roster = _assignment_roster(db, assignment)
    latest = _latest_submitted_attempts(db, assignment.id)
    submitted_attempts = [latest[m.student_id] for m in roster if m.student_id in latest]
    scores = [round((a.score or 0) / max(1, a.total or 0) * 100, 2) for a in submitted_attempts]
    assigned = len(roster)
    submitted = len(submitted_attempts)
    total_correct = sum(a.score or 0 for a in submitted_attempts)
    total_questions_answered = sum(a.total or 0 for a in submitted_attempts)

    students = []
    for membership in roster:
        student = membership.student
        attempt = latest.get(student.id)
        pct = round((attempt.score or 0) / max(1, attempt.total or 0) * 100, 2) if attempt else None
        students.append({
            "studentUserId": student.id,
            "studentName": student.username,
            "studentEmail": student.email,
            "studentCode": _student_code(student),
            "status": "submitted" if attempt else "pending",
            "attemptId": attempt.id if attempt else None,
            "attemptNo": attempt.attempt_no if attempt else None,
            "score": attempt.score if attempt else None,
            "total": attempt.total if attempt else assignment.question_count,
            "correct": attempt.score if attempt else None,
            "wrong": max(0, (attempt.total or 0) - (attempt.score or 0)) if attempt else None,
            "pct": pct,
            "startedAt": attempt.started_at.isoformat() if attempt else None,
            "submittedAt": attempt.submitted_at.isoformat() if attempt and attempt.submitted_at else None,
        })

    question_stats = []
    if include_questions:
        questions = (db.query(AssignmentQuestion)
                     .filter(AssignmentQuestion.assignment_id == assignment.id)
                     .order_by(AssignmentQuestion.position)
                     .all())
        for q in questions:
            answered = correct = 0
            option_counts = defaultdict(int)
            for attempt in submitted_attempts:
                try:
                    answers = json.loads(attempt.answers_json or "{}")
                except Exception:
                    answers = {}
                raw = answers.get(str(q.id))
                if isinstance(raw, int):
                    answered += 1
                    option_counts[str(raw)] += 1
                    if raw == q.correct_index:
                        correct += 1
            wrong = max(0, answered - correct)
            accuracy = round(correct / answered * 100, 2) if answered else 0
            question_stats.append({
                "questionId": q.id,
                "position": q.position,
                "question": q.question_body,
                "answered": answered,
                "correct": correct,
                "wrong": wrong,
                "accuracy": accuracy,
                "difficulty": "high" if accuracy < 50 else "medium" if accuracy < 75 else "low",
                "optionCounts": dict(option_counts),
            })

    difficult = sorted(question_stats, key=lambda x: (x["accuracy"], -x["answered"]))[:5]
    return {
        "assignment": _assignment_payload(assignment, db, False),
        "summary": {
            "assigned": assigned,
            "submitted": submitted,
            "pending": max(0, assigned - submitted),
            "completionRate": round(submitted / assigned * 100, 2) if assigned else 0,
            "average": round(sum(scores) / len(scores), 2) if scores else 0,
            "highest": max(scores) if scores else 0,
            "lowest": min(scores) if scores else 0,
            "correct": total_correct,
            "wrong": max(0, total_questions_answered - total_correct),
        },
        "students": students,
        "questionStats": question_stats,
        "weakQuestions": difficult,
    }


@app.get("/api/v1/analytics/teacher/overview")
def teacher_analytics_overview(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_teacher(current_user)
    classes = (db.query(Classroom)
               .filter(Classroom.teacher_id == current_user.id)
               .order_by(Classroom.created_at.desc()).all())
    class_rows = []
    all_latest_scores = []
    total_students = total_assignments = total_submissions = 0
    for classroom in classes:
        members = db.query(ClassMember).filter(ClassMember.class_id == classroom.id, ClassMember.status == "active").count()
        assignments = (db.query(Assignment)
                       .filter(Assignment.class_id == classroom.id, Assignment.teacher_id == current_user.id)
                       .order_by(Assignment.created_at.desc()).all())
        assignment_rows = []
        class_scores = []
        class_submissions = 0
        for assignment in assignments:
            report = _assignment_analytics_payload(db, assignment, False)
            summary = report["summary"]
            class_submissions += summary["submitted"]
            if summary["submitted"]:
                latest = _latest_submitted_attempts(db, assignment.id)
                roster_ids = {m.student_id for m in _assignment_roster(db, assignment)}
                vals = [round((a.score or 0) / max(1, a.total or 0) * 100, 2) for sid, a in latest.items() if sid in roster_ids]
                class_scores.extend(vals); all_latest_scores.extend(vals)
            assignment_rows.append({**report["assignment"], "analytics": summary})
        total_students += members
        total_assignments += len(assignments)
        total_submissions += class_submissions
        class_rows.append({
            **_class_payload(classroom, db, False),
            "studentCount": members,
            "assignmentCount": len(assignments),
            "submissionCount": class_submissions,
            "average": round(sum(class_scores) / len(class_scores), 2) if class_scores else 0,
            "assignments": assignment_rows,
        })
    return {
        "summary": {
            "classes": len(classes), "students": total_students,
            "assignments": total_assignments, "submissions": total_submissions,
            "average": round(sum(all_latest_scores) / len(all_latest_scores), 2) if all_latest_scores else 0,
        },
        "classes": class_rows,
    }


@app.get("/api/v1/analytics/assignments/{assignment_id}")
def teacher_assignment_analytics(assignment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    assignment = _teacher_assignment(db, assignment_id, current_user)
    return _assignment_analytics_payload(db, assignment, True)


@app.get("/api/v1/analytics/assignments/{assignment_id}/export.csv")
def export_assignment_analytics_csv(assignment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    assignment = _teacher_assignment(db, assignment_id, current_user)
    report = _assignment_analytics_payload(db, assignment, False)
    def csv_cell(value):
        text = "" if value is None else str(value)
        return '"' + text.replace('"', '""') + '"'
    headers = ["Student", "Email", "Student Code", "Status", "Attempt", "Score", "Total", "Percentage", "Submitted At"]
    lines = [",".join(csv_cell(x) for x in headers)]
    for row in report["students"]:
        lines.append(",".join(csv_cell(row.get(key)) for key in [
            "studentName", "studentEmail", "studentCode", "status", "attemptNo",
            "score", "total", "pct", "submittedAt"
        ]))
    filename = re.sub(r"[^A-Za-z0-9_-]+", "_", assignment.title).strip("_") or f"assignment_{assignment.id}"
    return Response("\ufeff" + "\n".join(lines), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}_results.csv"'})



# ════════════════════════════════════════════════════════════════
# PHASE 6 — REVISION STUDIO
# ════════════════════════════════════════════════════════════════
class RevisionItemCreateSchema(BaseModel):
    source_type: str = "personal_quiz"
    source_id: Optional[int] = None
    title: str
    score_pct: float
    questions: list = []

class RevisionNoteCreateSchema(BaseModel):
    title: str
    body: str

class StudyPlanCreateSchema(BaseModel):
    title: str = "My revision plan"
    target_pct: int = 80
    days: int = 7

class TeacherRecommendationSchema(BaseModel):
    student_id: int
    class_id: int
    title: str
    message: str
    due_at: Optional[datetime] = None

def _json_load(value, default):
    try: return json.loads(value or "")
    except Exception: return default

def _revision_item_payload(row):
    return {"id":row.id,"sourceType":row.source_type,"sourceId":row.source_id,"title":row.title,
            "scorePct":row.score_pct,"questionCount":row.question_count,
            "weakQuestions":_json_load(row.weak_questions_json,[]),"status":row.status,
            "bestRetakePct":row.best_retake_pct,"createdAt":row.created_at.isoformat(),
            "updatedAt":row.updated_at.isoformat()}

def _upsert_revision_item(db, student_id, source_type, source_id, title, pct, questions):
    if pct >= 75: return None
    row=db.query(RevisionItem).filter(RevisionItem.student_id==student_id,RevisionItem.source_type==source_type,RevisionItem.source_id==source_id).first() if source_id else None
    weak=[q for q in (questions or []) if not q.get("correct",False)]
    if row is None:
        row=RevisionItem(student_id=student_id,source_type=source_type,source_id=source_id,title=title[:180],score_pct=pct,question_count=len(questions or []),weak_questions_json=json.dumps(weak),status="active")
        db.add(row)
    else:
        row.title=title[:180];row.score_pct=pct;row.question_count=len(questions or []);row.weak_questions_json=json.dumps(weak);row.status="active";row.updated_at=datetime.utcnow()
    db.commit();db.refresh(row);return row

@app.get("/api/v1/revision/dashboard")
def revision_dashboard(current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    if (current_user.role or "student") != "student": raise HTTPException(403,"Student access required")
    items=db.query(RevisionItem).filter(RevisionItem.student_id==current_user.id).order_by(RevisionItem.updated_at.desc()).all()
    notes=db.query(RevisionNote).filter(RevisionNote.student_id==current_user.id).order_by(RevisionNote.updated_at.desc()).all()
    plans=db.query(StudyPlan).filter(StudyPlan.student_id==current_user.id).order_by(StudyPlan.updated_at.desc()).all()
    recs=db.query(TeacherRevisionRecommendation).filter(TeacherRevisionRecommendation.student_id==current_user.id,TeacherRevisionRecommendation.status=="active").order_by(TeacherRevisionRecommendation.created_at.desc()).all()
    return {"items":[_revision_item_payload(x) for x in items],
            "notes":[{"id":x.id,"title":x.title,"text":x.body,"createdAt":x.created_at.isoformat(),"updatedAt":x.updated_at.isoformat()} for x in notes],
            "plans":[{"id":x.id,"title":x.title,"targetPct":x.target_pct,"days":x.days,"steps":_json_load(x.plan_json,[]),"status":x.status,"createdAt":x.created_at.isoformat()} for x in plans],
            "recommendations":[{"id":x.id,"title":x.title,"message":x.message,"classId":x.class_id,"dueAt":x.due_at.isoformat() if x.due_at else None,"createdAt":x.created_at.isoformat()} for x in recs]}

@app.post("/api/v1/revision/items")
def create_revision_item(data:RevisionItemCreateSchema,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    if (current_user.role or "student") != "student": raise HTTPException(403,"Student access required")
    row=_upsert_revision_item(db,current_user.id,data.source_type,data.source_id,data.title,data.score_pct,data.questions)
    return {"created":bool(row),"item":_revision_item_payload(row) if row else None}

@app.patch("/api/v1/revision/items/{item_id}/complete")
def complete_revision_item(item_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    row=db.query(RevisionItem).filter(RevisionItem.id==item_id,RevisionItem.student_id==current_user.id).first()
    if not row: raise HTTPException(404,"Revision item not found")
    row.status="completed";row.updated_at=datetime.utcnow();db.commit();return {"status":"success"}

@app.post("/api/v1/revision/notes")
def create_revision_note(data:RevisionNoteCreateSchema,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    if not data.body.strip(): raise HTTPException(400,"Note body is required")
    row=RevisionNote(student_id=current_user.id,title=(data.title.strip() or "Revision note")[:180],body=data.body.strip())
    db.add(row);db.commit();db.refresh(row);return {"id":row.id,"title":row.title,"text":row.body,"createdAt":row.created_at.isoformat()}

@app.delete("/api/v1/revision/notes/{note_id}")
def delete_revision_note_api(note_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    row=db.query(RevisionNote).filter(RevisionNote.id==note_id,RevisionNote.student_id==current_user.id).first()
    if not row: raise HTTPException(404,"Revision note not found")
    db.delete(row);db.commit();return {"status":"success"}

@app.post("/api/v1/revision/plans/generate")
def generate_study_plan(data:StudyPlanCreateSchema,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    days=max(3,min(30,data.days));target=max(50,min(100,data.target_pct))
    active=db.query(RevisionItem).filter(RevisionItem.student_id==current_user.id,RevisionItem.status=="active").order_by(RevisionItem.score_pct.asc()).all()
    topics=[x.title for x in active[:5]] or ["Current course material"]
    steps=[]
    for day in range(1,days+1):
        topic=topics[(day-1)%len(topics)]
        action="Review weak questions" if day%3==1 else ("Attempt a focused retake" if day%3==2 else "Summarize concepts and test recall")
        steps.append({"day":day,"topic":topic,"action":action,"minutes":25 if day<days else 35})
    row=StudyPlan(student_id=current_user.id,title=data.title[:180],target_pct=target,days=days,plan_json=json.dumps(steps))
    db.add(row);db.commit();db.refresh(row);return {"id":row.id,"title":row.title,"targetPct":target,"days":days,"steps":steps}

@app.post("/api/v1/revision/recommendations")
def create_teacher_revision_recommendation(data:TeacherRecommendationSchema,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    _require_teacher(current_user)
    classroom=db.query(Classroom).filter(Classroom.id==data.class_id,Classroom.teacher_id==current_user.id,Classroom.is_active==1).first()
    if not classroom: raise HTTPException(404,"Class not found")
    member=db.query(ClassMember).filter(ClassMember.class_id==classroom.id,ClassMember.student_id==data.student_id,ClassMember.status=="active").first()
    if not member: raise HTTPException(400,"Student is not an active member of this class")
    row=TeacherRevisionRecommendation(teacher_id=current_user.id,student_id=data.student_id,class_id=classroom.id,title=data.title[:180],message=data.message.strip(),due_at=data.due_at)
    db.add(row);db.commit();db.refresh(row);return {"id":row.id,"status":"success"}


@app.get("/api/v1/ml-info")
def ml_info():
    train_meta = load_training_meta()
    return {
        "engine": "AI Quiz Generator — Deep Learning Edition v8.0",
        "question_generation_mode": quiz_engine.qgen.mode,
        "embedding_model": "all-MiniLM-L6-v2 (384-dim)" if quiz_engine.embedder.available() else "unavailable",
        "difficulty_model": "fine-tuned PyTorch NN" if quiz_engine.classifier.is_trained() else "heuristic fallback",
        "difficulty_training_run": train_meta,
        "pipeline_steps": [
            {"step": 1, "name": "PyMuPDF", "purpose": "Extract text from PDFs"},
            {"step": 2, "name": "NLTK Tokenizer", "purpose": "Split text into sentences"},
            {"step": 3, "name": "Sentence-Transformer", "purpose": "Dense 384-dim embeddings"},
            {"step": 4, "name": "Cosine Centrality", "purpose": "Rank sentences by importance"},
            {"step": 5, "name": "KMeans Clustering", "purpose": "Group by topic"},
            {"step": 6, "name": "Multi-word NP Extractor", "purpose": "Find answer spans"},
            {"step": 7, "name": "T5 Question Generator", "purpose": "Generate natural questions"},
            {"step": 8, "name": "Semantic Distractors", "purpose": "Plausible wrong options"},
            {"step": 9, "name": "PyTorch DifficultyNet", "purpose": "Classify difficulty"},
            {"step": 10, "name": "NumPy Quality Scorer", "purpose": "Score and rank questions"},
        ],
    }


@app.get("/health")
def health():
    """Lightweight liveness endpoint; does not depend on external services."""
    return {
        "status": "healthy",
        "version": "10.0-production-ready",
        "app_env": APP_ENV,
    }


@app.get("/ready")
def readiness(db: Session = Depends(get_db)):
    """Readiness endpoint used by Docker/orchestrators before routing traffic."""
    try:
        db.execute(sql_text("SELECT 1"))
    except Exception as exc:
        logger.exception("Database readiness check failed")
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    return {
        "status": "ready",
        "version": "10.0-production-ready",
        "pdf_support": PDF_SUPPORT,
        "embedding_model_ready": bool(quiz_engine and quiz_engine.embedder.available()),
        "question_gen_mode": quiz_engine.qgen.mode if quiz_engine else "migration/test mode",
        "difficulty_model_trained": bool(quiz_engine and quiz_engine.classifier.is_trained()),
        "database": "sqlite" if DATABASE_URL.startswith("sqlite") else "postgresql",
    }


if __name__ == "__main__":
    import uvicorn
    logger.info("=" * 70)
    logger.info("🚀 AI Quiz Generator v8.0")
    logger.info("📍 http://127.0.0.1:8000")
    logger.info("📚 Docs: http://127.0.0.1:8000/docs")
    logger.info("=" * 70)
    uvicorn.run(app, host="127.0.0.1", port=8000, reload=False)
