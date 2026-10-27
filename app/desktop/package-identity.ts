import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { UpgradeProof } from '../shared/upgrade';

const run = promisify(execFile);
/** 核对实际包的签名及稳定发布者约束，不以版本号替代来源身份。 */
export async function verifyPackageIdentity(
  bundle: string,
): Promise<UpgradeProof['application']> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('UPGRADE_PACKAGE_UNVERIFIED');
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
      timeout: 8000,
      maxBuffer: 65536,
    });
    const { stdout, stderr } = await run(
      '/usr/bin/codesign',
      ['-d', '-r-', '--verbose=4', bundle],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 65536 },
    );
    const output = stdout + stderr;
    const identifier = output.match(/^Identifier=(.+)$/m)?.[1];
    const requirement = output.match(/^designated => (.+)$/m)?.[1];
    if (
      identifier !== 'local.helpr.desktop' ||
      !requirement ||
      /\bcdhash\b/.test(requirement) ||
      !/\bcertificate\b|\banchor\b/.test(requirement)
    )
      throw Error('UPGRADE_PACKAGE_UNVERIFIED');
    return {
      platform: 'darwin',
      arch: 'arm64',
      identifier,
      requirement: createHash('sha256').update(requirement).digest('hex'),
    };
  } catch {
    throw Error('UPGRADE_PACKAGE_UNVERIFIED');
  }
}
