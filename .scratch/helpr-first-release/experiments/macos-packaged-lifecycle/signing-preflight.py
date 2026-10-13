"""Use only a newly generated experiment key; never trust a root or export user keys."""
from pathlib import Path
import subprocess, json, secrets, shlex, hashlib, datetime

root=Path(__file__).resolve().parent
private=root/'private'; private.mkdir(mode=0o700,exist_ok=True)
out=root/'artifacts'; out.mkdir(exist_ok=True)
report=out/'signing-preflight.json'
assert not report.exists(), 'Preserve the first attempt; do not overwrite its report.'
keychain=private/'lab-signing.keychain-db'
assert not keychain.exists(), 'Do not replace an existing keychain.'
password=secrets.token_urlsafe(32)
(private/'signing-password').write_text(password)
(private/'signing-password').chmod(0o600)
records=[]
def command(args,allow_failure=False,record=True):
    r=subprocess.run(args,capture_output=True,text=True)
    if record:
        records.append({'program':Path(args[0]).name,'exit':r.returncode,'stdout':r.stdout.replace(password,'[redacted]'),'stderr':r.stderr.replace(password,'[redacted]')})
    if not allow_failure and r.returncode: raise RuntimeError(f'{Path(args[0]).name} failed; see public preflight record')
    return r
original=shlex.split(command(['security','list-keychains','-d','user'],record=False).stdout)
try:
    (private/'certificate.cnf').write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=helpr Lifecycle Lab 20261012\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\n')
    command(['openssl','req','-new','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','7','-config',str(private/'certificate.cnf'),'-keyout',str(private/'lab.key'),'-out',str(private/'lab.crt')],record=False)
    (private/'lab.key').chmod(0o600)
    command(['openssl','pkcs12','-export','-inkey',str(private/'lab.key'),'-in',str(private/'lab.crt'),'-out',str(private/'lab.p12'),'-passout','file:'+str(private/'signing-password')],record=False)
    (private/'lab.p12').chmod(0o600)
    command(['security','create-keychain','-p',password,str(keychain)])
    command(['security','unlock-keychain','-p',password,str(keychain)])
    command(['security','import',str(private/'lab.p12'),'-k',str(keychain),'-P',password,'-T','/usr/bin/codesign'])
    cert=command(['openssl','x509','-in',str(private/'lab.crt'),'-noout','-fingerprint','-sha1']).stdout.strip().split('=')[1].replace(':','')
    command(['security','find-identity','-p','codesigning',str(keychain)])
    public={'certificateSha1':cert,'keychain':'private/lab-signing.keychain-db','kind':'new self-signed experiment certificate','systemTrustChanged':False,'existingPrivateKeysReadOrExported':False}
    (root/'signer.json').write_text(json.dumps(public,indent=2)+'\n')
    probe=private/'probe.c';probe.write_text('int main(void){return 0;}\n')
    command(['clang',str(probe),'-o',str(private/'probe')])
    signed=command(['codesign','--force','--sign',cert,'--keychain',str(keychain),'--identifier','local.helpr.lifecycle-lab.probe','--timestamp=none',str(private/'probe')],allow_failure=True)
    if signed.returncode==0:
        command(['codesign','--verify','--strict','--verbose=2',str(private/'probe')])
        command(['codesign','-d','-r-',str(private/'probe')])
    else: public['blocked']='Signing requires a usable identity; no trust workaround applied.'
except Exception as e:
    public={'error':str(e),'systemTrustChanged':False}
finally:
    command(['security','list-keychains','-d','user','-s',*original],record=False)
    restored=shlex.split(command(['security','list-keychains','-d','user'],record=False).stdout)
    public.update({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'searchListRestored':restored==original,'commands':records})
    report.write_text(json.dumps(public,indent=2)+'\n')
    print(json.dumps({'certificate':public.get('certificateSha1'),'searchListRestored':public['searchListRestored'],'error':public.get('error'),'blocked':public.get('blocked'),'lastCommand':records[-1] if records else None},indent=2))
