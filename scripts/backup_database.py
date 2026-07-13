"""Create a timestamped SQLite backup or PostgreSQL pg_dump."""
from __future__ import annotations
import os, shutil, sqlite3, subprocess
from datetime import datetime, timezone
from pathlib import Path

url=os.getenv("DATABASE_URL", "sqlite:///./ai_quiz.db")
out=Path(os.getenv("BACKUP_DIR", "backups")); out.mkdir(parents=True, exist_ok=True)
stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
if url.startswith("sqlite"):
    source=Path(url.split("///",1)[1])
    target=out/f"ai_quiz_{stamp}.db"
    src=sqlite3.connect(source); dst=sqlite3.connect(target)
    with dst: src.backup(dst)
    src.close(); dst.close()
    print(target)
elif url.startswith(("postgresql", "postgres")):
    target=out/f"ai_quiz_{stamp}.sql"
    with target.open("wb") as fh: subprocess.run(["pg_dump", url], stdout=fh, check=True)
    print(target)
else:
    raise SystemExit("Unsupported DATABASE_URL")
