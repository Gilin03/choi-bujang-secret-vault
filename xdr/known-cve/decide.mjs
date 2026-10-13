const PATTERNS = [
  {
    id: 'log4shell_jndi_lookup',
    name: 'CVE-2021-44228 JNDI 원격 조회 구문',
  },
  {
    id: 'known_log4shell_scanner_trace',
    name: '알려진 Log4Shell 점검 도구 흔적',
  },
  {
    id: 'cve_t1190_review',
    name: 'CVE-2021-44228·T1190 검토 신호',
  },
];

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const JNDI_LOOKUP = /\$\s*\{\s*jndi\s*:\s*(?:ldap|ldaps|rmi|dns|iiop|corba|nis|nds|http|https)\s*:\/\/[^}\s]+\}/iu;
const SCANNER_MARKER = /\b(?:log4j[\s_-]?scan|log4shell[\s_-]?scanner|nuclei)\b/iu;
const CVE_CONTEXT = /\b(?:cve[-_ ]?2021[-_ ]?44228|log4j2?|log4shell)\b/iu;

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
      result = result.replace(/%(?:24|7b|7d|3a|2f)/giu, (encoded) => ({
        '%24': '$', '%7b': '{', '%7d': '}', '%3a': ':', '%2f': '/',
      })[encoded.toLowerCase()] ?? encoded);
    }
  }
  return result.toLowerCase();
}

function requestText(alert) {
  const data = objectOrEmpty(alert?.data);
  const fields = [
    data.url,
    data.uri,
    data.query,
    data.request_uri,
    data.requestUri,
    data.useragent,
    data.user_agent,
    data.referer,
    data.headers,
    data.request_headers,
    data.requestHeaders,
  ];
  const strings = [];
  for (const field of fields) {
    if (typeof field === 'string') strings.push(normalize(field));
    else if (field && typeof field === 'object') {
      for (const value of Object.values(field)) {
        if (typeof value === 'string') strings.push(normalize(value));
      }
    }
  }
  return strings.join('\n');
}

function validIpv4(value) {
  return typeof value === 'string'
    && IPV4.test(value)
    && value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function hasT1190(alert) {
  const mitre = objectOrEmpty(alert?.rule).mitre;
  return Array.isArray(mitre) && mitre.includes('T1190');
}

function reason(pattern, detail) {
  return `${pattern.name}: ${detail}`;
}

export function decide(alert) {
  const rule = objectOrEmpty(alert?.rule);
  const data = objectOrEmpty(alert?.data);
  const request = requestText(alert);
  const jndiMatch = JNDI_LOOKUP.test(request);
  const scannerMatch = SCANNER_MARKER.test(request) && CVE_CONTEXT.test(request);
  const cveMention = CVE_CONTEXT.test(request);
  const level = Number.isFinite(rule.level) ? rule.level : 0;
  const sourceValid = validIpv4(data.srcip);

  if (jndiMatch && level >= 10 && sourceValid) {
    return {
      action: 'block',
      confidence: 0.97,
      reason: reason(PATTERNS[0], '완성된 JNDI 원격 조회와 고위험 규칙·출발 주소 확인'),
    };
  }

  if (scannerMatch) {
    return {
      action: 'alert',
      confidence: 0.75,
      reason: reason(PATTERNS[1], '점검 도구 흔적만으로는 차단하지 않고 검토'),
    };
  }

  if (jndiMatch || cveMention || hasT1190(alert)) {
    return {
      action: 'alert',
      confidence: jndiMatch ? 0.75 : 0.55,
      reason: reason(PATTERNS[2], '완전한 고위험 차단 근거가 부족해 검토'),
    };
  }

  return {
    action: 'record',
    confidence: 0.1,
    reason: 'CVE-2021-44228 JNDI·점검 도구 신호 없음',
  };
}
