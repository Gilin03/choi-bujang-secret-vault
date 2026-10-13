const PATTERNS = [
  { id: 'unsigned_or_unlisted_service_persistence', name: '서명 없는 신규·미등록 서비스 지속성' },
  { id: 'unfamiliar_scheduled_task_persistence', name: '낯선 예약 작업 지속성' },
  { id: 'startup_folder_persistence', name: '시작 폴더·프로그램 지속성' },
];

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const TEMP_PATH = /(?:^|[\\/])(?:temp|tmp)(?:[\\/]|$)/iu;

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function alertText(alert) {
  const rule = objectOrEmpty(alert?.rule);
  const data = objectOrEmpty(alert?.data);
  return [rule.description, data.path].filter((value) => typeof value === 'string').join('\n').toLowerCase();
}

function mitreTags(alert) {
  const tags = objectOrEmpty(alert?.rule).mitre;
  return new Set(Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : []);
}

function validIpv4(value) {
  return typeof value === 'string'
    && IPV4.test(value)
    && value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function matchedPattern(alert) {
  const rule = objectOrEmpty(alert?.rule);
  const data = objectOrEmpty(alert?.data);
  const text = alertText(alert);
  const tags = mitreTags(alert);
  const level = Number.isFinite(rule.level) ? rule.level : 0;
  const service = /\bservice\b|서비스/u.test(text);
  const task = /scheduled task|\btask\b|예약 작업/u.test(text);
  const startup = /startup|시작 폴더|시작 프로그램/u.test(text);
  const newOrChanged = /new|새|등록|추가|변경|바뀌|changed|created/u.test(text);
  const unsigned = /unsigned|서명\s*(?:이\s*)?없|서명되지/u.test(text);
  const unlistedPersistent = /평소 목록에 없|목록에 없는|unlisted|다시 켜도|재부팅 후|persist|남도록/u.test(text);
  const unfamiliar = /처음 보는|낯선|임의 문자열|random|unknown/u.test(text);
  const offHours = /수업 시간 밖|업무 시간 밖|outside (?:class|business) hours/u.test(text);
  const tempPath = typeof data.path === 'string' && TEMP_PATH.test(data.path);
  const highSeverity = level >= 10;

  if (highSeverity && tags.has('T1543') && tags.has('T1053')
      && startup && task && tempPath) {
    return PATTERNS[2];
  }

  if (highSeverity && tags.has('T1543') && service
      && ((unsigned && newOrChanged) || unlistedPersistent)) {
    return PATTERNS[0];
  }

  if (highSeverity && tags.has('T1053') && task && tempPath && (unfamiliar || offHours)) {
    return PATTERNS[1];
  }

  if (highSeverity && tags.has('T1543') && startup && (unlistedPersistent || newOrChanged)) {
    return PATTERNS[2];
  }

  return null;
}

function reviewPattern(alert) {
  const text = alertText(alert);
  const tags = mitreTags(alert);
  if (tags.has('T1053') || /scheduled task|\btask\b|예약 작업/u.test(text)) return PATTERNS[1];
  if (/startup|시작 폴더|시작 프로그램/u.test(text)) return PATTERNS[2];
  return PATTERNS[0];
}

export function decide(alert) {
  const rule = objectOrEmpty(alert?.rule);
  const data = objectOrEmpty(alert?.data);
  const level = Number.isFinite(rule.level) ? rule.level : 0;
  const pattern = matchedPattern(alert);

  if (pattern && validIpv4(data.srcip)) {
    return {
      action: 'block',
      confidence: 0.95,
      reason: `${pattern.name}: 고위험 규칙과 지속성 신호가 함께 확인됨`,
    };
  }

  const tags = mitreTags(alert);
  const text = alertText(alert);
  const hasPersistenceSignal = tags.has('T1543') || tags.has('T1053')
    || /\bservice\b|서비스|scheduled task|예약 작업|startup|시작 폴더|시작 프로그램/u.test(text);
  if (hasPersistenceSignal && level >= 5) {
    const review = reviewPattern(alert);
    return {
      action: 'alert',
      confidence: 0.65,
      reason: `${review.name}: 증거가 불충분해 검토 필요`,
    };
  }

  return {
    action: 'record',
    confidence: 0.1,
    reason: '지속성 패턴 일치 없음: 정상 이벤트로 기록',
  };
}
