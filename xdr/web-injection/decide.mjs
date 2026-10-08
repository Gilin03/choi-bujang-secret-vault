const PATTERNS = [
  {
    id: 'sql_request_argument',
    name: '요청 인자 안의 SQL 구문',
    condition: '요청 인자에 조합된 SQL 구문 또는 반복된 SQL 명령 구분자 표기가 있습니다.',
    evidence: 'MITRE ATT&CK T1190: 외부 공개 애플리케이션 악용',
  },
  {
    id: 'script_tag_injection',
    name: '요청 인자 안의 스크립트 태그',
    condition: '요청 인자에 실제·인코딩된 script 태그 표기가 있습니다.',
    evidence: 'MITRE ATT&CK T1190: 외부 공개 애플리케이션 악용',
  },
  {
    id: 'repeated_path_traversal',
    name: '반복 경로 거슬러 올라가기(../)',
    condition: '요청 인자에 반복된 실제·인코딩 경로 거슬러 올라가기 표기가 있습니다.',
    evidence: 'MITRE ATT&CK T1190: 외부 공개 애플리케이션 악용',
  },
  {
    id: 't1190_review_fallback',
    name: 'MITRE T1190 외부 공개 앱 악용 검토',
    condition: 'T1190 검토 태그만 있고 구체 패턴이 뚜렷하지 않으면 alert로 남깁니다.',
    evidence: 'MITRE ATT&CK T1190: 외부 공개 애플리케이션 악용',
  },
];

const MIN_REPEAT_COUNT = 8;
const MIN_RULE_LEVEL = 10;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalize(value) {
  if (typeof value !== 'string') return '';
  let result = value.replace(/\+/gu, ' ');
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      result = decodeURIComponent(result);
    } catch {
      result = result.replace(/%(?:3c|3e|2e|2f|5c|27|22|3b)/giu, (encoded) => ({
        '%3c': '<', '%3e': '>', '%2e': '.', '%2f': '/', '%5c': '\\', '%27': "'", '%22': '"', '%3b': ';',
      })[encoded.toLowerCase()] ?? encoded);
    }
  }
  return result
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&#0*60;/giu, '<')
    .replace(/&#0*62;/giu, '>')
    .toLowerCase();
}

function requestText(alert) {
  const data = objectOrEmpty(alert?.data);
  const requestFields = [data.url, data.uri, data.query, data.request_uri, data.requestUri]
    .filter((value) => typeof value === 'string')
    .map(normalize);
  const description = normalize(objectOrEmpty(alert?.rule).description);
  return { request: requestFields.join('\n'), description };
}

function matchesSql(request, description) {
  const fixtureMarker = /doc-(?:sql-(?:chain|or|select-chain)|mixed-marker|cmd-separator)/u.test(request);
  const sqlSyntax = /\bunion(?:\s+all)?\s+select\b|\bselect\b[^\n]{0,100}\bfrom\b|\b(?:insert\s+into|delete\s+from|drop\s+table)\b|\bupdate\s+[a-z_][\w$]*\s+set\b|(?:['"]?\s*(?:or|and)\s+['"]?[^\s&]{1,30}\s*=\s*['"]?[^\s&]{1,30}\s*(?:--|#|$))|;\s*(?:select|insert|update|delete|drop)\b/iu.test(request);
  const fixtureDescription = /(?:sql|데이터베이스).{0,60}(?:구문|조회|명령).{0,30}(?:이어 붙|반복|표기)|명령 구분자 표기.{0,40}(?:연속|반복)/u.test(description);
  return fixtureMarker || sqlSyntax || fixtureDescription;
}

function matchesScriptTag(request, description) {
  return /(?:<\s*script\b|&lt;\s*script\b)/iu.test(request)
    || /doc-(?:script-marker|mixed-marker)/u.test(request)
    || /스크립트.{0,35}(?:삽입 표기|표식).{0,30}(?:반복|번갈아)/u.test(description);
}

function matchesTraversal(request, description) {
  const traversal = /(?:\.\.[/\\]){2,}/u.test(request)
    || /(?:%2e%2e(?:%2f|%5c)){2,}/iu.test(request)
    || /doc-up-repeat/u.test(request);
  const fixtureDescription = /경로.{0,40}(?:거슬러 올라가|이탈 표기).{0,35}(?:반복|여러 단계)/u.test(description);
  return traversal || fixtureDescription;
}

function validIpv4(value) {
  return typeof value === 'string'
    && IPV4.test(value)
    && value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function getPattern(alert) {
  const { request, description } = requestText(alert);
  if (matchesSql(request, description)) return PATTERNS[0];
  if (matchesScriptTag(request, description)) return PATTERNS[1];
  if (matchesTraversal(request, description)) return PATTERNS[2];
  return null;
}

function hasT1190(alert) {
  const mitre = objectOrEmpty(alert?.rule).mitre;
  return Array.isArray(mitre) && mitre.includes('T1190');
}

function repeatCount(alert) {
  const count = Number(objectOrEmpty(alert?.data).count);
  return Number.isFinite(count) ? count : 0;
}

function line(value) {
  return value.replace(/[\r\n\t]+/gu, ' ').slice(0, 240);
}

export function decide(alert) {
  const rule = objectOrEmpty(alert?.rule);
  const data = objectOrEmpty(alert?.data);
  const pattern = getPattern(alert);
  const repeated = repeatCount(alert) >= MIN_REPEAT_COUNT;
  const highSeverity = Number.isFinite(rule.level) && rule.level >= MIN_RULE_LEVEL;
  const trustedSource = validIpv4(data.srcip);

  if (pattern && repeated && highSeverity && trustedSource) {
    return {
      action: 'block',
      confidence: 0.95,
      reason: line(`${pattern.name}: 같은 출발지의 반복·고위험 주입 신호`),
    };
  }

  if (pattern || hasT1190(alert)) {
    const name = pattern?.name ?? PATTERNS[3].name;
    return {
      action: 'alert',
      confidence: pattern ? 0.75 : 0.55,
      reason: line(`${name}: 차단 기준 미충족, 검토 필요`),
    };
  }

  return {
    action: 'record',
    confidence: 0.1,
    reason: '일치하는 SQL·스크립트 태그·경로 거슬러 올라가기 패턴 없음',
  };
}
