import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 使用 builder 生成的标准完整应用布局，不跨 bundle 拼接 Chromium helper 路径。
// 在签名前复制；APFS 可用时克隆文件，仍由 builder 统一签名并独立检查两层。
export function packageWorkspaceHost(appPath) {
  const destination = path.join(appPath, 'Contents/Frameworks/helpr Workspace.app');
  if (fs.existsSync(destination)) throw Error('HOST_PACKAGE_ALREADY_EXISTS');
  const temporary = fs.mkdtempSync(path.join(path.dirname(appPath), '.helpr-host-'));
  const staged = path.join(temporary, 'helpr Workspace.app');
  const readInfo = file => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
  const writeInfo = (file, info) => execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', file, '-'], { input: JSON.stringify(info) });
  try {
    fs.cpSync(appPath, staged, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    const contents = path.join(staged, 'Contents');
    fs.renameSync(path.join(contents, 'MacOS/helpr'), path.join(contents, 'MacOS/helpr Workspace Helper'));
    const infoFile = path.join(contents, 'Info.plist');
    const info = readInfo(infoFile);
    info.CFBundleIdentifier = 'local.helpr.desktop.workspace';
    info.CFBundleExecutable = 'helpr Workspace Helper';
    info.CFBundleDisplayName = 'helpr';
    info.CFBundleName = 'helpr';
    info.LSUIElement = false;
    info.ElectronMainProcess = true;
    writeInfo(infoFile, info);
    for (const suffix of ['', ' (GPU)', ' (Renderer)', ' (Plugin)']) {
      const file = path.join(contents, `Frameworks/helpr Helper${suffix}.app/Contents/Info.plist`);
      const helper = readInfo(file);
      helper.CFBundleIdentifier = helper.CFBundleIdentifier.replace('local.helpr.desktop.helper', info.CFBundleIdentifier + '.helper');
      writeInfo(file, helper);
    }
    fs.renameSync(staged, destination);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
