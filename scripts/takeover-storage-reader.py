"""只在临时夹具库持有 SHARED 读锁；不修改业务行，7 秒兜底释放。"""
import json
import os
import select
import sqlite3
import sys
import subprocess
import time
from pathlib import Path

file = Path(sys.argv[1]).resolve(strict=True)
base = Path('/private/tmp' if sys.platform == 'darwin' else '/tmp').resolve(strict=True)
root = base / f'helpr-workspace-validation-{os.getuid()}'
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
            journal = Path(str(file) + '-journal')
            if journal.exists() and journal.stat().st_size > 512:
                # 独立进程的新读者被拒绝，证明 PENDING；本进程只保留原始 SHARED。
                command = """import sqlite3,sys
try:
 c=sqlite3.connect(sys.argv[1]+'?mode=ro',uri=True,timeout=0)
 c.execute('SELECT name FROM sqlite_master LIMIT 1').fetchall()
 c.close()
except sqlite3.OperationalError as e:
 if str(e)=='database is locked': sys.exit(2)
 raise
"""
                result = subprocess.run([sys.executable, '-c', command, file.as_uri()], timeout=0.5, capture_output=True)
                if result.returncode not in (0, 2):
                    raise ValueError('INDEPENDENT_READER_PROBE_FAILED')
                if result.returncode == 2:
                    observed = True
                    emit('writer-waiting', independentReaderBusy=True, journalBytes=journal.stat().st_size)

    else:
        emit('expired')
finally:
    reader.rollback()
    reader.close()
    emit('reader-released')
