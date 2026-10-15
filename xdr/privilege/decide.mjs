const PATTERNS = Object.freeze([
  {
    id: 'administrator_group_addition',
    name: '관리자 그룹 추가',
    condition: 'T1078 경보에서 administrators 그룹에 계정을 추가·재추가한 내용이 있고 규칙 수준이 10 이상이면 명확한 권한 변경으로 판단합니다.',
    evidence: 'MITRE ATT&CK T1078: 기존 계정 자격 증명 악용은 권한 상승과 접근 통제 우회에 쓰일 수 있습니다.',
    source: 'https://attack.mitre.org/techniques/T1078/',
  },
  {
    id: 'unfamiliar_administrator_command',
    name: '처음 보는 관리자 명령',
    condition: 'T1068 경보의 관리자 명령 또는 관리자 권한 전환이 처음 보는 주소·다른 계정 권한·새 관리자 세션과 함께 나타나고 규칙 수준이 10 이상이면 명확한 신호입니다. 반복이나 출처가 확인되지 않은 관리자 명령은 검토 경보로 둡니다.',
    evidence: 'MITRE ATT&CK T1068: 소프트웨어 취약점 악용은 더 높은 권한으로 이어질 수 있습니다.',
    source: 'https://attack.mitre.org/techniques/T1068/',
  },
  {
    id: 'after_hours_privilege_use',
    name: '업무 시간 밖 권한 사용',
    condition: '경보 설명이 업무 시간 밖 또는 수업 시간 밖의 관리자 그룹 변경, 관리자 명령 또는 권한 전환을 명시하고 규칙 수준이 10 이상이면 명확한 신호입니다. 시간대는 설명에 있는 근거 없이 추정하지 않습니다.',
    evidence: 'MITRE ATT&CK T1068 및 T1078: 권한 상승 악용과 기존 계정 사용을 함께 검토합니다.',
    source: 'https://attack.mitre.org/techniques/T1068/',
  },
]);

const BLOCK_CONFIDENCE = 0.9;
const ALERT_CONFIDENCE = 0.65;
const RECORD_CONFIDENCE = 0.1;
const BLOCK_LEVEL = 10;

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasMitre(rule, id) {
  return Array.isArray(rule.mitre) && rule.mitre.includes(id);
}

function safeLine(value) {
  return value.replace(/[\r\n\t]+/gu, ' ').slice(0, 200);
}

export function decide(alert) {
  const rule = objectOrEmpty(alert?.rule);
  const data = objectOrEmpty(alert?.data);
  const description = typeof rule.description === 'string' ? rule.description : '';
  const normalizedGroup = typeof data.group === 'string' ? data.group.trim().toLowerCase() : '';
  const administratorGroup = normalizedGroup === 'administrators'
    || /관리자\s*그룹/u.test(description);
  const groupAddition = administratorGroup
    && /(?:관리자\s*그룹.{0,40}(?:추가|들어)|다시\s*관리자(?:로|\s*그룹).{0,20}(?:들어|추가|복귀))/u.test(description);
  const adminCommand = /(?:관리자|권한)\s*명령/u.test(description);
  const privilegeTransition = /권한\s*상승|관리자\s*권한.{0,12}(?:바뀌|변경|전환)|세션이\s*관리자\s*권한으로\s*바뀌/u.test(description);
  const unfamiliar = /처음\s*(?:보|봅|본)|낯선|다른\s*계정의\s*권한|방금\s*관리자가\s*된/u.test(description);
  const outsideHours = /(?:수업|업무|근무)(?:\s*시간)?\s*밖|업무처럼\s*보이지\s*않는\s*시각/u.test(description);
  const level = Number.isFinite(rule.level) ? rule.level : 0;
  const hasT1068 = hasMitre(rule, 'T1068');
  const hasT1078 = hasMitre(rule, 'T1078');
  const supportedTechnique = hasT1068 || hasT1078;
  const isPrivilegeActivity = adminCommand || privilegeTransition || groupAddition;
  const firstSeenAdminActivity = (hasT1068 || hasT1078)
    && ((adminCommand && unfamiliar) || (privilegeTransition && unfamiliar));
  const afterHoursActivity = supportedTechnique && outsideHours && isPrivilegeActivity;

  let pattern = null;
  if (afterHoursActivity) pattern = PATTERNS[2];
  else if (groupAddition && hasT1078) pattern = PATTERNS[0];
  else if (firstSeenAdminActivity) pattern = PATTERNS[1];

  if (pattern && level >= BLOCK_LEVEL) {
    return {
      action: 'block',
      confidence: BLOCK_CONFIDENCE,
      reason: safeLine(`${pattern.name}: 고위험 권한 상승 신호 확인`),
    };
  }

  if (pattern || (hasT1068 && (adminCommand || privilegeTransition))) {
    const reviewPattern = pattern ?? PATTERNS[1];
    return {
      action: 'alert',
      confidence: ALERT_CONFIDENCE,
      reason: safeLine(`${reviewPattern.name}: 명확한 차단 조건을 충족하지 않아 확인 필요`),
    };
  }

  return {
    action: 'record',
    confidence: RECORD_CONFIDENCE,
    reason: '일치하는 권한 상승 패턴 없음',
  };
}
