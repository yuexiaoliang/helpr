"""Inspect this experiment's stored ACL requirements without reading a secret.

Diagnostic only: no ACL, trust, or keychain mutations. These deprecated private
read-only APIs are documented in Apple's open source, not a product dependency:
https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/SecTrustedApplicationPriv.h
https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/SecTrustedApplication.cpp
"""
import ctypes as c
import json
from pathlib import Path

base = Path(__file__).resolve().parent
output = base / 'artifacts/lab-keychain-identity-comparison.json'
assert not output.exists(), 'Preserve the previous diagnostic evidence'
sec = c.CDLL('/System/Library/Frameworks/Security.framework/Security')
cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
ptr, u = c.c_void_p, c.c_uint32
pp = c.POINTER(ptr)

def api(lib, name, args, restype=c.c_int32):
    fn = getattr(lib, name)
    fn.argtypes, fn.restype = args, restype
    return fn

api(sec, 'SecKeychainSetUserInteractionAllowed', [c.c_ubyte])(0)
find = api(sec, 'SecKeychainFindGenericPassword', [ptr,u,c.c_char_p,u,c.c_char_p,ptr,ptr,pp])
access = api(sec, 'SecKeychainItemCopyAccess', [ptr,pp])
acl = api(sec, 'SecAccessCopyACLList', [ptr,pp])
contents = api(sec, 'SecACLCopyContents', [ptr,pp,pp,c.POINTER(u)])
requirement = api(sec, 'SecTrustedApplicationCopyRequirement', [ptr,pp])
requirement_text = api(sec, 'SecRequirementCopyString', [ptr,u,pp])
validate = api(sec, 'SecTrustedApplicationValidateWithPath', [ptr,c.c_char_p])
count = api(cf, 'CFArrayGetCount', [ptr], c.c_long)
at = api(cf, 'CFArrayGetValueAtIndex', [ptr,c.c_long], ptr)
get_string = api(cf, 'CFStringGetCString', [ptr,c.c_char_p,c.c_long,u], c.c_ubyte)
release = api(cf, 'CFRelease', [ptr], None)
service, account = b'helpr Lifecycle Lab Safe Storage', b'helpr Lifecycle Lab Key'
item = ptr()
status = find(None,len(service),service,len(account),account,None,None,c.byref(item))
report = {'passwordDataRequested':False, 'findStatus':status, 'acl':[]}
candidates = [base/'installed/helpr Lifecycle Lab.app', *sorted((base/'installed').glob('before-update-*.app'))]
if status == 0:
    a = ptr()
    report['accessStatus'] = access(item,c.byref(a))
    if report['accessStatus'] == 0:
        rows = ptr()
        report['aclStatus'] = acl(a,c.byref(rows))
        if report['aclStatus'] == 0:
            for i in range(count(rows)):
                apps, description, prompt = ptr(), ptr(), u()
                s = contents(at(rows,i),c.byref(apps),c.byref(description),c.byref(prompt))
                if s == 0 and apps:
                    for j in range(count(apps)):
                        app = at(apps,j)
                        req = ptr()
                        entry = {'aclIndex':i, 'applicationIndex':j, 'requirementStatus':requirement(app,c.byref(req)), 'validations':[]}
                        if req:
                            text = ptr()
                            entry['requirementTextStatus'] = requirement_text(req,0,c.byref(text))
                            if text:
                                buffer = c.create_string_buffer(16384)
                                if get_string(text,buffer,len(buffer),0x08000100):
                                    entry['requirement'] = buffer.value.decode('utf8')
                                release(text)
                            release(req)
                        for candidate in candidates:
                            entry['validations'].append({'path':str(candidate.relative_to(base)), 'status':validate(app,str(candidate).encode())})
                        report['acl'].append(entry)
                if apps: release(apps)
                if description: release(description)
            release(rows)
        release(a)
    release(item)
output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
