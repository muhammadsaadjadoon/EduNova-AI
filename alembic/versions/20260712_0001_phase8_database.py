"""Phase 8 database hardening and audit log

Revision ID: 20260712_0001
Revises: None
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260712_0001"
down_revision = None
branch_labels = None
depends_on = None

INDEXES = {
    "quiz_sessions": [("ix_quiz_sessions_user_created", ["user_id", "created_at"])],
    "questions": [("ix_questions_session_position", ["session_id", "id"])],
    "quiz_attempts": [("ix_quiz_attempts_user_attempted", ["user_id", "attempted_at"]), ("ix_quiz_attempts_session_attempted", ["session_id", "attempted_at"])],
    "assignment_questions": [("ix_assignment_questions_assignment_position", ["assignment_id", "position"])],
    "assignment_attempts": [("ix_assignment_attempts_student_status", ["student_id", "status"]), ("ix_assignment_attempts_assignment_submitted", ["assignment_id", "submitted_at"])],
    "revision_items": [("ix_revision_student_status_updated", ["student_id", "status", "updated_at"])],
}

def _has_table(bind, table):
    return table in inspect(bind).get_table_names()

def _has_index(bind, table, name):
    return any(i["name"] == name for i in inspect(bind).get_indexes(table))

def upgrade() -> None:
    bind = op.get_bind()
    # Bootstrap every current table for a clean installation; existing tables are preserved.
    from app import Base
    Base.metadata.create_all(bind=bind)
    if not _has_table(bind, "audit_logs"):
        op.create_table(
            "audit_logs",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("actor_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("actor_role", sa.String(20), nullable=True),
            sa.Column("action", sa.String(80), nullable=False),
            sa.Column("entity_type", sa.String(60), nullable=True),
            sa.Column("entity_id", sa.String(80), nullable=True),
            sa.Column("method", sa.String(10), nullable=False),
            sa.Column("path", sa.String(300), nullable=False),
            sa.Column("status_code", sa.Integer(), nullable=False),
            sa.Column("ip_hash", sa.String(64), nullable=True),
            sa.Column("user_agent", sa.String(300), nullable=True),
            sa.Column("details_json", sa.Text(), nullable=False, server_default="{}"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
    for name, cols in [
        ("ix_audit_logs_actor_user_id", ["actor_user_id"]),
        ("ix_audit_logs_action", ["action"]),
        ("ix_audit_logs_created_at", ["created_at"]),
        ("ix_audit_actor_created", ["actor_user_id", "created_at"]),
        ("ix_audit_action_created", ["action", "created_at"]),
        ("ix_audit_entity", ["entity_type", "entity_id"]),
    ]:
        if not _has_index(bind, "audit_logs", name):
            op.create_index(name, "audit_logs", cols)
    for table, indexes in INDEXES.items():
        if _has_table(bind, table):
            for name, cols in indexes:
                if not _has_index(bind, table, name):
                    op.create_index(name, table, cols)

def downgrade() -> None:
    bind = op.get_bind()
    for table, indexes in INDEXES.items():
        if _has_table(bind, table):
            for name, _ in indexes:
                if _has_index(bind, table, name):
                    op.drop_index(name, table_name=table)
    if _has_table(bind, "audit_logs"):
        op.drop_table("audit_logs")
