import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export function writeValidationJSON(file, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
