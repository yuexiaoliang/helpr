"""07 本轮资料的只读 SHARED 等待；25 秒独立释放，不修改产品数据库。"""
import json
import os
from pathlib import Path
import select
import sqlite3
import subprocess
import sys
import time

file = Path(sys.argv[1]).resolve(strict=True)
root = Path('/private/tmp' if sys.platform == 'darwin' else '/tmp').resolve(strict=True) / f'helpr-workspace-validation-{os.getuid()}'
if file.name != 'workspace.sqlite' or file.parent.name != 'backup07-CPFJP0' or root not in file.parents:
    raise ValueError('FIXED_BACKUP_PROFILE_REQUIRED')
connection = sqlite3.connect(file.as_uri() + '?mode=ro', uri=True, timeout=0)
connection.execute('PRAGMA query_only=ON')
connection.execute('BEGIN')
connection.execute('SELECT name FROM sqlite_master LIMIT 1').fetchall()
def emit(stage, **extra):
    print(json.dumps(dict(stage=stage, at=time.time()*1000, **extra)), flush=True)
emit('reader-held')
end = time.monotonic() + 25
observed = False
try:
    while time.monotonic() < end:
        if select.select([sys.stdin], [], [], .02)[0]:
            if sys.stdin.readline().strip() != 'release':
                raise ValueError('RELEASE_REQUIRED')
            break
        if not observed:
            journal = Path(str(file) + '-journal')
            if journal.exists() and journal.stat().st_size > 512:
                probe = """import sqlite3,sys
try:
 c=sqlite3.connect(sys.argv[1]+'?mode=ro',uri=True,timeout=0)
 c.execute('PRAGMA query_only=ON')
 c.execute('SELECT name FROM sqlite_master LIMIT 1').fetchall()
 c.close()
except sqlite3.OperationalError as e:
 if str(e)=='database is locked': sys.exit(2)
 raise
"""
                result = subprocess.run([sys.executable, '-c', probe, file.as_uri()], timeout=.5, capture_output=True)
                if result.returncode not in (0, 2):
                    raise ValueError('READER_PROBE_FAILED')
                if result.returncode == 2:
                    observed = True
                    emit('writer-waiting', independentReaderBusy=True)
    else:
        emit('expired')
finally:
    connection.rollback()
    connection.close()
    emit('reader-released')
