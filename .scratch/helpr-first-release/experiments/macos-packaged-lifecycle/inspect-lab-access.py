"""Read ACL metadata for this lab's single Keychain item, never the secret value.
All APIs are read-only except disabling optional UI in THIS diagnostic process.
"""
import ctypes as c,json
from pathlib import Path
sec=c.CDLL('/System/Library/Frameworks/Security.framework/Security');cf=c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
ptr=c.c_void_p;pp=c.POINTER(ptr);u=c.c_uint32

def api(lib,name,args,restype=c.c_int32):
 f=getattr(lib,name);f.argtypes=args;f.restype=restype;return f
api(sec,'SecKeychainSetUserInteractionAllowed',[c.c_ubyte])(0)
find=api(sec,'SecKeychainFindGenericPassword',[ptr,u,c.c_char_p,u,c.c_char_p,ptr,ptr,pp])
copyAccess=api(sec,'SecKeychainItemCopyAccess',[ptr,pp]);copyACL=api(sec,'SecAccessCopyACLList',[ptr,pp])
contents=api(sec,'SecACLCopyContents',[ptr,pp,pp,c.POINTER(u)])
copyData=api(sec,'SecTrustedApplicationCopyData',[ptr,pp]);count=api(cf,'CFArrayGetCount',[ptr],c.c_long);at=api(cf,'CFArrayGetValueAtIndex',[ptr,c.c_long],ptr)
size=api(cf,'CFDataGetLength',[ptr],c.c_long);bytesAt=api(cf,'CFDataGetBytePtr',[ptr],ptr)
service=b'helpr Lifecycle Lab Safe Storage';account=b'helpr Lifecycle Lab Key';item=ptr();status=find(None,len(service),service,len(account),account,None,None,c.byref(item))
report={'itemService':service.decode(),'passwordDataRequested':False,'findStatus':status,'acl':[]}
if status==0:
 access=ptr();status=copyAccess(item,c.byref(access));report['accessStatus']=status
 if status==0:
  acls=ptr();status=copyACL(access,c.byref(acls));report['aclStatus']=status
  if status==0:
   for i in range(count(acls)):
    apps,description,prompt=ptr(),ptr(),u();status=contents(at(acls,i),c.byref(apps),c.byref(description),c.byref(prompt));row={'index':i,'status':status,'promptSelector':prompt.value,'trustedPaths':[]}
    if status==0 and apps:
     for j in range(count(apps)):
      raw=ptr();s=copyData(at(apps,j),c.byref(raw))
      if s==0:
       value=c.string_at(bytesAt(raw),size(raw));candidate=value.split(b'\0')[0]
       row['trustedPaths'].append(candidate.decode('utf8',errors='replace') if candidate.startswith(b'/') else '[non-path application metadata omitted]')
    report['acl'].append(row)
p=Path(__file__).resolve().parent/'artifacts/lab-keychain-access-metadata.json';assert not p.exists();p.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
