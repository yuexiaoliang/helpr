import { randomUUID } from 'node:crypto';
import { localFixtureOrigin } from './startup';
import type { CredentialProtection } from './model-service';

export const FIXTURE_API_KEY = 'local-fixture-not-a-secret';
/** 仅显式隔离验证使用；不接受真实密钥，不接触系统凭据。 */
export class LocalFixture implements CredentialProtection {
  readonly origin: string;
  readonly partition = 'helpr-fixture-web';
  private readonly token = 'local-fixture:' + randomUUID();
  constructor(origin: string) {
    this.origin = localFixtureOrigin(origin);
  }
  protect(value: string): string {
    if (value !== FIXTURE_API_KEY) throw Error('MODEL_CREDENTIAL_UNAVAILABLE');
    return this.token;
  }
  reveal(value: string): string {
    if (value !== this.token) throw Error('MODEL_CREDENTIAL_UNAVAILABLE');
    return FIXTURE_API_KEY;
  }
  allowsRequest(value: string): boolean {
    if (value === 'about:blank') return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === 'http:' &&
        url.origin === this.origin &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }
  checkModel(endpoint: string): void {
    if (endpoint !== this.origin + '/v1') throw Error('INVALID_MODEL_ENDPOINT');
  }
}
