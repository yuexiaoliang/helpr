"""只在临时夹具库持有 SHARED 读锁；不修改业务行，7 秒兜底释放。"""
import json
import os
import select
import sqlite3
import sys
import time
from pathlib import Path

file = Path(sys.argv[1]).resolve(strict=True)
root = Path(f'/private/tmp/helpr-workspace-validation-{os.getuid()}')
if file.name != 'workspace.sqlite' or root not in file.parents:
    raise ValueError('FIXTURE_DATABASE_REQUIRED')
reader = sqlite3.connect(file.as_uri() + '?mode=ro', uri=True, timeout=0)
reader.execute('PRAGMA query_only=ON')
reader.execute('BEGIN')
reader.execute('SELECT name FROM sqlite_master LIMIT 1').fetchall()

def emit(stage, **extra):
    print(json.dumps(dict(stage=stage, at=time.time() * 1000, **extra)), flush=True)

emit('reader-held')
end = time.monotonic() + 7
observed = False
try:
    while time.monotonic() < end:
        if select.select([sys.stdin], [], [], 0.01)[0]:
            if sys.stdin.readline().strip() != 'release':
                raise ValueError('RELEASE_REQUIRED')
            break
        if not observed:
            probe = sqlite3.connect(file.as_uri() + '?mode=rw', uri=True, timeout=0)
            try:
                probe.execute('BEGIN IMMEDIATE')
                probe.rollback()
            except sqlite3.OperationalError as error:
                if getattr(error, 'sqlite_errorcode', sqlite3.SQLITE_BUSY) != sqlite3.SQLITE_BUSY or str(error) != 'database is locked':
                    raise
                journal = Path(str(file) + '-journal')
                if journal.exists() and journal.stat().st_size > 512:
                    observed = True
                    emit('writer-waiting')
            finally:
                probe.close()
    else:
        emit('expired')
finally:
    reader.rollback()
    reader.close()
    emit('reader-released')
