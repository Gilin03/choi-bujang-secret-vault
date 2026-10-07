import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const fixturePath = resolve(root, 'xdr', 'fixtures', 'brute-force.json');

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

export function redactText(value) {
  return stringValue(value)
    .replace(/\\+(?=["'])/gu, '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    // Once a credential assignment starts, hide its remainder too: unquoted values
    // may contain spaces or quotes. Losing description detail is safer than leaking it.
    .replace(/\b((?:[a-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|authorization|credential[_-]?fingerprint)(?:[_-]key)?)["']?\s*[:=][\s\S]*/giu,
      (_, label) => `${label}=[REDACTED]`)
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9._-]{12,}\b/gu, '[REDACTED]')
    .replace(/\b(?:sb_secret_|sk-)[a-zA-Z0-9_-]{12,}\b/gu, '[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[REDACTED]')
    .slice(0, 500);
}

export function readAlerts(alerts) {
  if (!Array.isArray(alerts)) throw new TypeError('invalid_wazuh_alerts');

  return alerts.map((alert) => {
    const rule = alert?.rule ?? {};
    const data = alert?.data ?? {};
    const level = Number(rule.level);
    return {
      timestamp: redactText(alert?.timestamp ?? alert?.['@timestamp']),
      sourceAddress: redactText(data.srcip),
      account: redactText(data.srcuser),
      ruleLevel: Number.isFinite(level) ? level : null,
      description: redactText(rule.description),
    };
  });
}

async function main() {
  const inputPath = process.argv[2] ? resolve(process.argv[2]) : fixturePath;
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const rows = readAlerts(input);
  for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
  if (rows.length !== input.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('경보 읽기 실패: 입력 파일이나 Wazuh 경보 형식을 확인하세요.\n');
    process.exitCode = 1;
  });
}
