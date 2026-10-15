const PATTERNS = Object.freeze([
  {
    id: 'large_transfer_to_new_destination',
    name: '처음 보는 목적지의 대용량 전송',
    condition: 'T1041 또는 T1048 경보에서 처음 보는 목적지로 50MB 이상이 전송되거나, 80MB 이상 전송과 반복·대체 포트·자료 묶음 전체 반출 신호가 함께 있고 규칙 수준이 10 이상이면 명확한 유출 후보로 판단합니다.',
    evidence: 'MITRE ATT&CK T1041은 명령 통로를 통한 유출, T1048은 다른 프로토콜을 통한 유출을 다루며 이 규칙은 큰 외부 전송의 구체적 신호를 함께 확인합니다.',
    source: 'https://attack.mitre.org/techniques/T1041/',
  },
  {
    id: 'off_hours_archive_exfiltration',
    name: '업무 시간 밖 압축 파일 반출',
    condition: 'T1041 또는 T1048 경보가 업무·수업 시간 밖임을 설명에 명시하고, 압축 파일이 목적지로 실제 전송되었으며 규칙 수준이 10 이상이면 명확한 유출 후보로 판단합니다.',
    evidence: 'MITRE ATT&CK T1048은 명령 통로가 아닌 프로토콜을 통한 유출을 다루며, 시간 밖 압축 파일의 외부 전송은 검토할 구체적 반출 신호입니다.',
    source: 'https://attack.mitre.org/techniques/T1048/',
  },
]);

const BLOCK_CONFIDENCE = 0.9;
const ALERT_CONFIDENCE = 0.65;
const RECORD_CONFIDENCE = 0.1;
const BLOCK_LEVEL = 10;
const LARGE_TRANSFER_BYTES = 50_000_000;
const VERY_LARGE_TRANSFER_BYTES = 80_000_000;

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasTechnique(rule) {
  return Array.isArray(rule.mitre) && rule.mitre.some(id => id === 'T1041' || id === 'T1048');
}

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value);
  return 0;
}

function safeLine(value) {
  return value.replace(/[\r\n\t]+/gu, ' ').slice(0, 200);
}

export function decide(alert) {
  const rule = objectOrEmpty(alert?.rule);
  const data = objectOrEmpty(alert?.data);
  const description = typeof rule.description === 'string' ? rule.description : '';
  const level = Number.isFinite(rule.level) ? rule.level : 0;
  const bytes = numeric(data.bytes);
  const count = Math.max(numeric(data.count), numeric(data.files));
  const destination = typeof data.dstip === 'string' ? data.dstip : '';
  const supportedTechnique = hasTechnique(rule);
  const outbound = bytes > 0 && Boolean(destination)
    && !/(?:전송은\s*아직\s*없|전송이\s*실패|실패\s*\d+건)/u.test(description);
  const firstSeenDestination = /처음\s*보는\s*(?:목적지|주소|곳)|낯선\s*(?:목적지|주소)|평소와\s*다른\s*주소|다른\s*주소/u.test(description);
  const offHours = /(?:수업|업무|근무)(?:\s*시간)?\s*밖/u.test(description);
  const archive = /압축\s*파일|메모\s*묶음|묶음|자료실\s*전체/u.test(description);
  const repeatedOrAlternate = /반복|\d+번|연속|쓰지\s*않던\s*포트|명령\s*통로|전체가/u.test(description)
    || count >= 5;
  const novelLargeTransfer = firstSeenDestination
    && bytes >= LARGE_TRANSFER_BYTES
    && level >= BLOCK_LEVEL;
  const repeatedLargeTransfer = bytes >= VERY_LARGE_TRANSFER_BYTES
    && repeatedOrAlternate
    && level >= BLOCK_LEVEL;
  const completeCollectionTransfer = /자료실\s*전체|전체가\s*외부\s*주소로\s*복사/u.test(description)
    && bytes >= LARGE_TRANSFER_BYTES
    && level >= BLOCK_LEVEL;
  const offHoursArchiveTransfer = offHours && archive && outbound && level >= BLOCK_LEVEL;

  if (supportedTechnique && outbound && (novelLargeTransfer || repeatedLargeTransfer
      || completeCollectionTransfer || offHoursArchiveTransfer)) {
    const pattern = offHoursArchiveTransfer ? PATTERNS[1] : PATTERNS[0];
    return {
      action: 'block',
      confidence: BLOCK_CONFIDENCE,
      reason: safeLine(`${pattern.name}: 고위험 외부 전송 신호 확인`),
    };
  }

  const ambiguousTransfer = supportedTechnique
    && level >= 5
    && outbound
    && /전송|나갔|보냈|반출|유출|압축|명령\s*통로|처음\s*보는|평소와\s*다른|이상|늘었|일부만/u.test(description);
  if (ambiguousTransfer) {
    const pattern = offHours && archive ? PATTERNS[1] : PATTERNS[0];
    return {
      action: 'alert',
      confidence: ALERT_CONFIDENCE,
      reason: safeLine(`${pattern.name}: 차단 기준에 이르지 않은 전송 신호 검토 필요`),
    };
  }

  return {
    action: 'record',
    confidence: RECORD_CONFIDENCE,
    reason: '일치하는 자료 반출 패턴 없음',
  };
}
