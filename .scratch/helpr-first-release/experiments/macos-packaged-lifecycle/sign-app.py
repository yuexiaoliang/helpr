"""Sign only this prepared lab bundle with its private experimental keychain.
No new trust roots, no user private key exports, no changed system policy.
"""
from pathlib import Path
import subprocess,json,shlex,sys,datetime,hashlib
root=Path(__file__).resolve().parent
build=sys.argv[1] if len(sys.argv)>1 else 'build-1'
source=root/'build'/build/'helpr Lifecycle Lab.app'
manifest=json.loads((root/'artifacts'/build/'manifest.json').read_text())
version=manifest['version'];destination=root/'packages'/build/'helpr Lifecycle Lab.app'
report=root/'artifacts'/f'signed-{build}.json'
assert not report.exists()
assert source.is_dir() and not destination.exists()
destination.parent.mkdir(parents=True,exist_ok=True)
subprocess.run(['/usr/bin/ditto',str(source),str(destination)],check=True)
keychain=root/'private/lab-signing.keychain-db'
password=(root/'private/signing-password').read_text()
original=shlex.split(subprocess.check_output(['security','list-keychains','-d','user'],text=True))
records=[]
def run(args,check=True):
    r=subprocess.run(args,capture_output=True,text=True,timeout=30)
    records.append({'program':Path(args[0]).name,'target':args[-1],'exit':r.returncode,'stdout':r.stdout.replace(password,'[redacted]'),'stderr':r.stderr.replace(password,'[redacted]')})
    if check and r.returncode:raise RuntimeError(f'{Path(args[0]).name} failed: see signature record')
    return r
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'version':version,'sourceBuild':build,'app':str(destination.relative_to(root)),'systemTrustChanged':False,'signatureKind':'self-signed certificate; internal test only','certificateSha1':'0A64F07EFA1ADDFF417EC018E622D71D539B8DE4'}
try:
    subprocess.run(['security','unlock-keychain','-p',password,str(keychain)],check=True,capture_output=True)
    subprocess.run(['security','list-keychains','-d','user','-s',str(keychain),*original],check=True,capture_output=True)
    sign=['codesign','--force','--sign','helpr Lifecycle Lab 20261012','--keychain',str(keychain),'--timestamp=none']
    magic={b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca'}
    for p in sorted(destination.rglob('*')):
        if p.is_symlink() or not p.is_file():continue
        with p.open('rb') as f:header=f.read(4)
        if header in magic:run(sign+[str(p)])
    nested=sorted((p for p in destination.rglob('*') if p.is_dir() and not p.is_symlink() and p.suffix in {'.framework','.app'}),key=lambda p:len(p.parts),reverse=True)
    for p in [*nested,destination]:run(sign+[str(p)])
    run(['codesign','--verify','--deep','--strict','--verbose=2',str(destination)])
    requirement=run(['codesign','-d','-r-',str(destination)])
    result['designatedRequirement']=requirement.stdout.strip()
    result['verified']=True
    assessment=run(['spctl','--assess','--type','execute','--verbose=4',str(destination)],check=False)
    result['gatekeeperAccepted']=assessment.returncode==0
except Exception as error:
    result['error']=str(error);print(str(error))
finally:
    subprocess.run(['security','list-keychains','-d','user','-s',*original],check=True,capture_output=True)
    result['searchListRestored']=shlex.split(subprocess.check_output(['security','list-keychains','-d','user'],text=True))==original
    result['commands']=records
    report.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='commands'},indent=2))
    if result.get('error'):sys.exit(1)
