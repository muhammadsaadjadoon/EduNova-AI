from pathlib import Path
import shutil, sys
if len(sys.argv)!=3: raise SystemExit("Usage: python scripts/restore_sqlite.py BACKUP.db TARGET.db")
src,dst=map(Path,sys.argv[1:]);
if not src.is_file(): raise SystemExit("Backup not found")
if dst.exists(): shutil.copy2(dst, dst.with_suffix(dst.suffix+".before-restore"))
shutil.copy2(src,dst); print(f"Restored {dst}")
