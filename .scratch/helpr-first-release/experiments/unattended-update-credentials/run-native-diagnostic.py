"""One bounded differential run, using only a new virtual Keychain item.

No Electron launch, no real credentials, no modification to the old experiment.
The old experiment's signing key is reused in place, never exported or printed.
"""
import datetime
import hashlib
import json
import re
import shlex
import shutil
import subprocess
import time
from pathlib import Path

base = Path(__file__).resolve().parent
old = base.parent / 'macos-packaged-lifecycle'
report_path = base / 'artifacts/native-differential.json'
assert not report_path.exists(), 'Do not repeat or overwrite this run'
build = base / 'build'
build.mkdir(exist_ok=True)
source = base / 'credential-probe.c'
snapshot = base / 'artifacts/native-diagnostic-source.c'
assert not snapshot.exists()
shutil.copy2(source, snapshot)
started = time.monotonic()
report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
          'limits': {'compiles': 2, 'signs': 2, 'probeRuns': 4, 'seconds': 900},
          'used': {'compiles': 0, 'signs': 0, 'probeRuns': 0},
          'electronStarts': 0, 'modelCalls': 0, 'remoteWrites': 0,
          'systemTrustChanged': False, 'records': []}
password = (old / 'private/signing-password').read_text()
keychain = old / 'private/lab-signing.keychain-db'
original_search = shlex.split(subprocess.check_output(['/usr/bin/security', 'list-keychains', '-d', 'user'], text=True))
active = build / 'credential-probe'
created = False


def persist():
    report['elapsedSeconds'] = round(time.monotonic() - started, 3)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


def command(args, category=None, expected_success=True, record=True):
    if time.monotonic() - started > report['limits']['seconds']:
        raise RuntimeError('DIAGNOSTIC_TIME_EXHAUSTED')
    if category:
        if report['used'][category] >= report['limits'][category]:
            raise RuntimeError('DIAGNOSTIC_BUDGET_EXHAUSTED')
        report['used'][category] += 1
        persist()
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=20)
    except subprocess.TimeoutExpired:
        report['records'].append({'program': Path(args[0]).name, 'timedOut': True})
        persist()
        raise RuntimeError('STOP_AFTER_TIMEOUT') from None
    if record:
        report['records'].append({'program': Path(args[0]).name, 'exit': result.returncode,
                                  'stdout': result.stdout.replace(password, '<REDACTED>'),
                                  'stderr': result.stderr.replace(password, '<REDACTED>')})
        persist()
    if expected_success and result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} failed; see bounded report')
    return result


def probe(version, operation, expected_success=True):
    shutil.copy2(build / f'probe-v{version}', active)
    result = command([str(active), operation], 'probeRuns', expected_success)
    return json.loads(result.stdout)


try:
    command(['/usr/bin/security', 'unlock-keychain', '-p', password, str(keychain)], record=False)
    command(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', str(keychain), *original_search], record=False)
    report['signatures'] = []
    for version in (1, 2):
        binary = build / f'probe-v{version}'
        command(['/usr/bin/clang', '-Wno-deprecated-declarations', '-O0', f'-DPROBE_VARIANT={version}',
                 str(source), '-framework', 'Security', '-framework', 'CoreFoundation', '-o', str(binary)], 'compiles')
        command(['/usr/bin/codesign', '--force', '--sign', 'helpr Lifecycle Lab 20261012',
                 '--keychain', str(keychain), '--identifier', 'local.helpr.update-credential-probe',
                 '--timestamp=none', str(binary)], 'signs')
        command(['/usr/bin/codesign', '--verify', '--strict', str(binary)])
        desc = command(['/usr/bin/codesign', '-d', '--verbose=4', '-r-', str(binary)])
        text = desc.stdout + desc.stderr
        report['signatures'].append({'variant': version,
                                     'cdhash': re.search(r'^CDHash=(.+)$', text, re.M).group(1),
                                     'requirement': re.search(r'^designated => (.+)$', text, re.M).group(1),
                                     'teamIdentifier': re.search(r'^TeamIdentifier=(.+)$', text, re.M).group(1)})
    # Do not leave the extra signing keychain in the user's search list while probing.
    command(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', *original_search], record=False)
    report['sameRequirement'] = report['signatures'][0]['requirement'] == report['signatures'][1]['requirement']
    report['differentCodeHashes'] = report['signatures'][0]['cdhash'] != report['signatures'][1]['cdhash']
    assert report['sameRequirement'] and report['differentCodeHashes']
    first = probe(1, 'create-read')
    created = True
    report['originalRead'] = first
    assert first['matches'] and first['interactionAllowed'] is False
    second = probe(2, 'read', expected_success=False)
    report['updatedRead'] = second
    report['updatedReadWithoutAuthorization'] = second.get('matches') is True
    report['blockedAfterCodeChange'] = second.get('matches') is False and second.get('status') in (-25308, -25293)
    # This red/green result is about the requested no-authorization behavior.
    report['requirementVerdict'] = 'pass' if report['updatedReadWithoutAuthorization'] else 'fail'
except Exception as error:
    report['error'] = str(error).replace(password, '<REDACTED>')
finally:
    subprocess.run(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', *original_search],
                   text=True, capture_output=True, timeout=20, check=True)
    report['searchListRestored'] = shlex.split(subprocess.check_output(['/usr/bin/security', 'list-keychains', '-d', 'user'], text=True)) == original_search
    if created and (build / 'probe-v1').exists():
        try:
            report['cleanup'] = probe(1, 'delete')
            report['absentAfterCleanup'] = probe(1, 'absent')['absent']
        except Exception as error:
            report['cleanupError'] = str(error).replace(password, '<REDACTED>')
    persist()
    print(json.dumps({key: value for key, value in report.items() if key != 'records'}, ensure_ascii=False, indent=2))
