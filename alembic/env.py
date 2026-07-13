from logging.config import fileConfig
import os
os.environ.setdefault("DB_MIGRATION_MODE", "true")
os.environ.setdefault("AUTO_CREATE_SCHEMA", "false")
from alembic import context
from sqlalchemy import engine_from_config, pool
from app import Base, DATABASE_URL, engine_db

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)
config.set_main_option("sqlalchemy.url", DATABASE_URL.replace("%", "%%"))
target_metadata = Base.metadata


def run_migrations_offline():
    context.configure(url=DATABASE_URL, target_metadata=target_metadata, literal_binds=True, compare_type=True, render_as_batch=DATABASE_URL.startswith("sqlite"))
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    with engine_db.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True, render_as_batch=DATABASE_URL.startswith("sqlite"))
        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
