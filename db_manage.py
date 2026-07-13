"""Safe database management commands for Phase 8."""
import argparse, os, shutil, sqlite3, subprocess, sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB = ROOT / "ai_quiz.db"

def backup():
    if not DB.exists():
        print("No local SQLite database found; nothing to back up.")
        return
    out = ROOT / "backups" / f"ai_quiz_{datetime.now():%Y%m%d_%H%M%S}.db"
    out.parent.mkdir(exist_ok=True)
    src = sqlite3.connect(DB)
    dst = sqlite3.connect(out)
    with dst:
        src.backup(dst)
    src.close(); dst.close()
    print(f"Backup created: {out}")

def integrity():
    if not DB.exists():
        print("No local SQLite database found.")
        return
    con = sqlite3.connect(DB)
    print("integrity_check:", con.execute("PRAGMA integrity_check").fetchone()[0])
    print("foreign_key_check rows:", len(con.execute("PRAGMA foreign_key_check").fetchall()))
    con.close()

def alembic(*args):
    env = os.environ.copy()
    env.setdefault("AUTO_CREATE_SCHEMA", "false")
    subprocess.check_call([sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("command", choices=["backup", "check", "upgrade", "stamp", "current"])
    a=p.parse_args()
    if a.command=="backup": backup()
    elif a.command=="check": integrity()
    elif a.command=="upgrade": backup(); alembic("upgrade", "head"); integrity()
    elif a.command=="stamp": alembic("stamp", "head")
    elif a.command=="current": alembic("current")
if __name__ == "__main__": main()
