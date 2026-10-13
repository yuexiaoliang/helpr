"""Read only the previous lab item's ACL metadata; never request its password.

These deprecated Security APIs are for diagnosis, not a product dependency.
No trust, item, ACL, keychain search list, or application mutation is performed.
User interaction is disabled for this diagnostic process only.
"""
import ctypes as c
import datetime
import json
import plistlib
import re
import subprocess
from pathlib import Path

base = Path(__file__).resolve().parent
old = base.parent / 'macos-packaged-lifecycle'
output = base / 'artifacts' / 'existing-keychain-access.json'
assert not output.exists(), 'Preserve existing diagnostic evidence'
sec = c.CDLL('/System/Library/Frameworks/Security.framework/Security')
cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
ptr, u = c.c_void_p, c.c_uint32
pp = c.POINTER(ptr)


def api(lib, name, args, restype=c.c_int32):
    fn = getattr(lib, name)
    fn.argtypes, fn.restype = args, restype
    return fn


release = api(cf, 'CFRelease', [ptr], None)
get_string = api(cf, 'CFStringGetCString', [ptr, c.c_char_p, c.c_long, u], c.c_ubyte)
count = api(cf, 'CFArrayGetCount', [ptr], c.c_long)
at = api(cf, 'CFArrayGetValueAtIndex', [ptr, c.c_long], ptr)


def string(value):
    if not value:
        return None
    buffer = c.create_string_buffer(65536)
    if not get_string(value, buffer, len(buffer), 0x08000100):
        raise RuntimeError('Metadata string not representable within limit')
    return buffer.value.decode('utf8')


ui_status = api(sec, 'SecKeychainSetUserInteractionAllowed', [c.c_ubyte])(0)
assert ui_status == 0, 'Do not query if interaction cannot be disabled'
find = api(sec, 'SecKeychainFindGenericPassword', [ptr, u, c.c_char_p, u, c.c_char_p, ptr, ptr, pp])
copy_access = api(sec, 'SecKeychainItemCopyAccess', [ptr, pp])
copy_acl = api(sec, 'SecAccessCopyACLList', [ptr, pp])
contents = api(sec, 'SecACLCopyContents', [ptr, pp, pp, c.POINTER(u)])
authorizations = api(sec, 'SecACLCopyAuthorizations', [ptr], ptr)
copy_req = api(sec, 'SecTrustedApplicationCopyRequirement', [ptr, pp])
req_text = api(sec, 'SecRequirementCopyString', [ptr, u, pp])
validate = api(sec, 'SecTrustedApplicationValidateWithPath', [ptr, c.c_char_p])

service = b'helpr Lifecycle Lab Safe Storage'
account = b'helpr Lifecycle Lab Key'
item = ptr()
# Both password length and password buffer output pointers are NULL.
status = find(None, len(service), service, len(account), account, None, None, c.byref(item))
report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'itemService': service.decode(), 'passwordDataRequested': False,
          'mutations': [], 'interactionDisabledInProbe': True, 'findStatus': status,
          'acls': [], 'candidateSignatures': []}
candidates = [old / 'installed/helpr Lifecycle Lab.app',
              *sorted((old / 'installed').glob('before-update-*.app'))]
for candidate in candidates:
    if not candidate.is_dir():
        continue
    result = subprocess.run(['/usr/bin/codesign', '-d', '--verbose=4', str(candidate)],
                            capture_output=True, text=True, timeout=20)
    values = {}
    for line in result.stderr.splitlines():
        key, sep, value = line.partition('=')
        if sep and key in {'Identifier', 'CDHash', 'TeamIdentifier', 'Authority'}:
            values.setdefault(key, []).append(value)
    report['candidateSignatures'].append({'path': str(candidate.relative_to(old)),
                                         'exit': result.returncode, **values})

if status == 0:
    access = ptr()
    report['accessStatus'] = copy_access(item, c.byref(access))
    if report['accessStatus'] == 0:
        acls = ptr()
        report['aclStatus'] = copy_acl(access, c.byref(acls))
        if report['aclStatus'] == 0:
            for i in range(count(acls)):
                acl = at(acls, i)
                auth = authorizations(acl)
                tags = [string(at(auth, n)) for n in range(count(auth))] if auth else []
                if auth:
                    release(auth)
                apps, description, prompt = ptr(), ptr(), u()
                row = {'index': i, 'authorizationTags': tags,
                       'contentsStatus': contents(acl, c.byref(apps), c.byref(description), c.byref(prompt)),
                       'trustedApplications': []}
                if row['contentsStatus'] == 0:
                    row['promptSelector'] = prompt.value
                    row['applicationListIsNull'] = not bool(apps)
                    if description and any('partition' in (tag or '').lower() for tag in tags):
                        raw = string(description)
                        if re.fullmatch(r'[0-9a-fA-F]+', raw or ''):
                            decoded = plistlib.loads(bytes.fromhex(raw))
                            row['partitionMetadata'] = decoded
                        else:
                            row['partitionDescription'] = raw
                    if apps:
                        for n in range(count(apps)):
                            trusted, req = at(apps, n), ptr()
                            entry = {'requirementStatus': copy_req(trusted, c.byref(req)), 'validations': []}
                            if req:
                                req_string = ptr()
                                entry['requirementTextStatus'] = req_text(req, 0, c.byref(req_string))
                                if req_string:
                                    entry['requirement'] = string(req_string)
                                    release(req_string)
                                release(req)
                            for candidate in candidates:
                                entry['validations'].append({'path': str(candidate.relative_to(old)),
                                                             'status': validate(trusted, str(candidate).encode())})
                            row['trustedApplications'].append(entry)
                if apps:
                    release(apps)
                if description:
                    release(description)
                report['acls'].append(row)
            release(acls)
        release(access)
    release(item)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
