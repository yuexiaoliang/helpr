import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 窗口宿主使用完整的 browser 入口与共享 framework，避免复制第二套运行时。
// 只在 builder 签名前组装；完整签名和安装后的来源核对仍由正常路径完成。
export function packageWorkspaceHost(appPath) {
  const contents = path.join(appPath, 'Contents');
  const host = path.join(contents, 'Frameworks/helpr Workspace.app/Contents');
  fs.cpSync(path.join(contents, 'Frameworks/helpr Helper.app/Contents'), host, { recursive: true });
  fs.unlinkSync(path.join(host, 'MacOS/helpr Helper'));
  const executable = path.join(host, 'MacOS/helpr Workspace Helper');
  fs.copyFileSync(path.join(contents, 'MacOS/helpr'), executable);
  // Electron 44 的 HELPER_EXECUTABLE 原生入口拒绝无 --type 的 browser 启动。
  // 完整入口移到固定 nested 布局后，只调整相对 framework 搜索位置，随后统一签名。
  const loadCommands = execFileSync('/usr/bin/otool', ['-l', executable], { encoding: 'utf8' });
  if (!/path @executable_path\/\.\.\/Frameworks \(offset \d+\)/.test(loadCommands))
    throw Error('UNEXPECTED_BROWSER_RPATH');
  execFileSync('/usr/bin/install_name_tool', ['-rpath', '@executable_path/../Frameworks', '@executable_path/../../..', executable]);
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')], { encoding: 'utf8' }));
  info.CFBundleIdentifier = 'local.helpr.desktop.workspace';
  info.CFBundleExecutable = 'helpr Workspace Helper';
  info.CFBundleDisplayName = 'helpr';
  info.CFBundleName = 'helpr';
  info.LSUIElement = false;
  // Electron 44 的 MainApplicationBundlePath 识别 Helper 后缀，沿用外层
  // Resources/ASAR 和 Frameworks 中的 renderer/GPU helper，不复制第二套运行时。
  info.ElectronMainProcess = false;
  if (info.CFBundleIconFile) {
    const icon = info.CFBundleIconFile.endsWith('.icns') ? info.CFBundleIconFile : info.CFBundleIconFile + '.icns';
    fs.mkdirSync(path.join(host, 'Resources'), { recursive: true });
    fs.copyFileSync(path.join(contents, 'Resources', icon), path.join(host, 'Resources', icon));
  }
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', path.join(host, 'Info.plist'), '-'], { input: JSON.stringify(info) });
}
