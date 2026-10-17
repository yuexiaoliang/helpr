// 仅当前 Mac 的开发签名；显式初始化一次，构建不生成或替换身份。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signAsync } from '@electron/osx-sign';

const policyFile = fileURLToPath(new URL('../development-signing.json', import.meta.url));
const directory = path.join(os.homedir(), 'Library/Application Support/helpr-development-signing');
const keychain = path.join(directory, 'identity.keychain-db');
const passwordFile = path.join(directory, 'keychain-password');
const certificateFile = path.join(directory, 'certificate.pem');
const demand = (value, code) => { if (!value) throw Error(code); };
function privatePath(file, isDirectory = false) {
  const stat = fs.lstatSync(file);
  demand(!stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && (isDirectory ? stat.isDirectory() : stat.isFile()), 'DEVELOPMENT_SIGNING_PRIVATE_PATH_REQUIRED');
}
function security(args) {
  // 密码只经过管道，不进入 argv、日志或构建清单；禁止 security 的 verbose 回显。
  const quote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  demand(args.every(value => !/[\r\n]/.test(value)), 'INVALID_KEYCHAIN_ARGUMENT');
  const input = args.map(quote).join(' ') + '\n';
  const result = spawnSync('/usr/bin/security', ['-i'], { input, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  demand(!result.error && result.status === 0 && !/Sec[A-Z]|\berror\b|\bfailed\b|\bdenied\b|not found/i.test(output), 'DEVELOPMENT_KEYCHAIN_UNAVAILABLE');
}
function command(executable, args, input) {
  try { return execFileSync(executable, args, { input, encoding: 'utf8', stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' }); }
  catch { throw Error('DEVELOPMENT_SIGNING_COMMAND_FAILED'); }
}
function certificatePolicy() {
  const cert = new X509Certificate(fs.readFileSync(certificateFile));
  return {
    schema: 1,
    purpose: 'local-development-only',
    subject: cert.subject,
    certificateSha1: createHash('sha1').update(cert.raw).digest('hex').toUpperCase(),
    certificateSha256: createHash('sha256').update(cert.raw).digest('hex'),
    expiresAt: new Date(cert.validTo).toISOString(),
  };
}
export function developmentIdentity() {
  demand(process.platform === 'darwin', 'MAC_REQUIRED');
  demand(fs.existsSync(policyFile), 'DEVELOPMENT_SIGNING_NOT_INITIALIZED');
  privatePath(directory, true);
  for (const file of [certificateFile, keychain, passwordFile]) privatePath(file);
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  const actual = certificatePolicy();
  demand(JSON.stringify(policy) === JSON.stringify(actual), 'DEVELOPMENT_SIGNING_IDENTITY_CHANGED');
  const cert = new X509Certificate(fs.readFileSync(certificateFile));
  demand(cert.issuer === cert.subject && cert.verify(cert.publicKey) && Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now(), 'DEVELOPMENT_SIGNING_CERTIFICATE_INVALID');
  const identities = command('/usr/bin/security', ['find-identity', '-p', 'codesigning', keychain]);
  demand(identities.includes(policy.certificateSha1), 'DEVELOPMENT_SIGNING_PRIVATE_KEY_MISSING');
  return policy;
}
function searchList() {
  return command('/usr/bin/security', ['list-keychains', '-d', 'user']).trim().split('\n').filter(Boolean).map(value => JSON.parse(value.trim()));
}
function restoreKeychainState(originalSearch) {
  let failure;
  try {
    security(['list-keychains', '-d', 'user', '-s', ...originalSearch]);
    demand(JSON.stringify(searchList()) === JSON.stringify(originalSearch), 'KEYCHAIN_SEARCH_LIST_NOT_RESTORED');
  } catch (error) { failure = error; }
  // 搜索列表恢复失败也须独立尝试锁回，恢复记录由调用方保留。
  try { if (fs.existsSync(keychain)) security(['lock-keychain', keychain]); }
  catch (error) { failure ??= error; }
  if (failure) throw failure;
}
function initialize() {
  demand(process.platform === 'darwin', 'MAC_REQUIRED');
  if (fs.existsSync(policyFile)) return developmentIdentity();
  demand(!fs.existsSync(directory), 'DEVELOPMENT_SIGNING_SETUP_ALREADY_EXISTS');
  fs.mkdirSync(directory, { mode: 0o700 });
  const password = randomBytes(32).toString('hex');
  fs.writeFileSync(passwordFile, password, { mode: 0o600, flag: 'wx' });
  const config = path.join(directory, 'openssl.cnf');
  const privateKey = path.join(directory, 'import-key.pem');
  const archive = path.join(directory, 'import.p12');
  const originalSearch = searchList();
  const recovery = path.join(directory, 'setup-recovery.json');
  fs.writeFileSync(recovery,JSON.stringify({originalSearch}),{flag:'wx',mode:0o600});
  let imported = false;
  try {
    fs.writeFileSync(config, '[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=signing\n[subject]\nCN=helpr Local Development\n[signing]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n', {mode:0o600,flag:'wx'});
    command('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:3072', '-x509', '-sha256', '-days', '3650', '-config', config, '-passout', 'file:' + passwordFile, '-keyout', privateKey, '-out', certificateFile]);
    for (const file of [privateKey, certificateFile]) fs.chmodSync(file, 0o600);
    command('/usr/bin/openssl', ['pkcs12', '-export', '-in', certificateFile, '-inkey', privateKey, '-passin', 'stdin', '-passout', 'file:' + passwordFile, '-out', archive], password + '\n');
    fs.chmodSync(archive, 0o600);
    security(['create-keychain', '-p', password, keychain]);
    security(['import', archive, '-k', keychain, '-f', 'pkcs12', '-P', password, '-x', '-T', '/usr/bin/codesign']);
    fs.chmodSync(keychain, 0o600);
    imported = true;
    const policy = certificatePolicy();
    fs.writeFileSync(policyFile, JSON.stringify(policy, null, 2) + '\n', {mode:0o644,flag:'wx'});
    return developmentIdentity();
  } finally {
    try {
      restoreKeychainState(originalSearch);
      fs.unlinkSync(recovery);
    } finally {
      if (imported) for (const file of [privateKey, archive, config]) fs.rmSync(file, { force: true });
    }
  }
}
function codePaths(bundle) {
  const paths = new Map();
  const magic = new Set(['cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca','cafebabf','bfbafeca']);
  const visit = current => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (/\.(app|framework|xpc)$/.test(current)) paths.set(fs.realpathSync(current), current);
      for (const name of fs.readdirSync(current)) visit(path.join(current,name));
    } else if (stat.isFile() && stat.size >= 4) {
      const fd = fs.openSync(current, 'r');
      const bytes = Buffer.alloc(4);
      try { fs.readSync(fd, bytes, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (magic.has(bytes.toString('hex'))) paths.set(fs.realpathSync(current), current);
    }
  };
  visit(bundle);
  return [...paths.values()].sort();
}
export function verifyDevelopmentSignature(bundle) {
  const policy = developmentIdentity();
  const images = [];
  for (const file of codePaths(bundle)) {
    // 独立核对证书约束，不把“自身签名有效”当作“选定身份正确”。
    try { execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R', '=certificate leaf = H"' + policy.certificateSha1 + '"', file], {stdio:'pipe',timeout:15000}); }
    catch { throw Error('DEVELOPMENT_SIGNATURE_REQUIRED:' + path.relative(bundle,file)); }
    const result = spawnSync('/usr/bin/codesign', ['-d', '-r-', '--verbose=4', file], {encoding:'utf8',timeout:15000});
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    const identifier = output.match(/^Identifier=(.+)$/m)?.[1];
    const requirement = output.match(/^designated => (.+)$/m)?.[1];
    const codeDirectorySha256 = output.match(/^CandidateCDHashFull sha256=([0-9a-f]{64})$/m)?.[1];
    demand(result.status === 0 && identifier && requirement && codeDirectorySha256 && !/\bcdhash\b/.test(requirement) && requirement.toUpperCase().includes(policy.certificateSha1), 'UNSTABLE_DEVELOPMENT_REQUIREMENT');
    images.push({path:path.relative(bundle,file)||'.',identifier,requirement,codeDirectorySha256});
  }
  demand(images.length > 0 && images.some(image=>image.path==='.'&&image.identifier==='local.helpr.desktop'), 'DEVELOPMENT_APPLICATION_ID_REQUIRED');
  demand(images.some(image=>image.path==='Contents/Frameworks/helpr Workspace.app'&&image.identifier==='local.helpr.desktop.workspace'), 'DEVELOPMENT_HOST_ID_REQUIRED');
  return { ...policy, images };
}
async function sign(bundle) {
  const policy = developmentIdentity();
  const password = fs.readFileSync(passwordFile, 'utf8');
  const lock = path.join(directory, 'signing.lock');
  const descriptor = fs.openSync(lock, 'wx', 0o600);
  let originalSearch;
  try {
    // 取得排他锁后才读取快照，不能把另一轮的临时列表当作原状态。
    originalSearch = searchList();
    fs.writeFileSync(descriptor, JSON.stringify({pid:process.pid,originalSearch}));
    security(['unlock-keychain', '-p', password, keychain]);
    // codesign 的私钥查找仍依赖搜索列表，即使已传 --keychain。
    security(['list-keychains', '-d', 'user', '-s', ...new Set([...originalSearch, keychain])]);
    const images = new Set(codePaths(path.resolve(bundle)));
    await signAsync({
      app: path.resolve(bundle), platform:'darwin',type:'development',
      identity:policy.certificateSha1,keychain,identityValidation:false,
      preAutoEntitlements:false,preEmbedProvisioningProfile:false,
      // 资源由外层封装签名覆盖；只逐项签 Mach-O／bundle，跳过 framework 符号链接别名。
      ignore:file=>!images.has(path.resolve(file)),
      optionsForFile:()=>({hardenedRuntime:false,timestamp:'none'}),
    });
    return verifyDevelopmentSignature(path.resolve(bundle));
  } finally {
    try {
      if (originalSearch) restoreKeychainState(originalSearch);
      fs.unlinkSync(lock);
    } finally { fs.closeSync(descriptor); }
  }
}
export function signDevelopmentPackage(bundle) {
  // 独立进程组限定整次签名，超时先结束本组工具，再由父进程恢复子进程保存的状态。
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'sign', bundle], {
    stdio:'pipe',encoding:'utf8',detached:true,timeout:120000,killSignal:'SIGKILL',
  });
  if (result.error || result.status !== 0) {
    if (result.pid) { try { process.kill(-result.pid,'SIGKILL'); } catch {} }
    const lock = path.join(directory,'signing.lock');
    if (fs.existsSync(lock)) {
      privatePath(lock);
      const owner = JSON.parse(fs.readFileSync(lock,'utf8'));
      if (owner.pid === result.pid) {
        restoreKeychainState(owner.originalSearch);
        fs.unlinkSync(lock);
      }
    }
    throw Error(result.error ? (result.error.code === 'ETIMEDOUT' ? 'DEVELOPMENT_SIGNING_TIME_LIMIT' : 'DEVELOPMENT_SIGNING_PROCESS_FAILED') : (result.stderr?.trim() || 'DEVELOPMENT_SIGNING_FAILED'));
  }
  return JSON.parse(result.stdout);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, bundle, ...extra] = process.argv.slice(2);
    demand(extra.length === 0, 'INVALID_SIGNING_ARGUMENT');
    const value = action === 'init' && !bundle ? initialize()
      : action === 'check' && !bundle ? developmentIdentity()
      : action === 'sign' && bundle ? await sign(bundle)
      : action === 'verify' && bundle ? verifyDevelopmentSignature(path.resolve(bundle))
      : undefined;
    demand(value, 'INVALID_SIGNING_ARGUMENT');
    console.log(JSON.stringify(value));
  } catch (error) {
    // security 的秘密只经过 stdin 且其错误已归一化；签名诊断仅含公开路径与证书身份。
    const code = error instanceof Error ? error.message.slice(0,4000) : 'DEVELOPMENT_SIGNING_FAILED';
    process.stderr.write(code + '\n'); process.exitCode=1;
  }
}
