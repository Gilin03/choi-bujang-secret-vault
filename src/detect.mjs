// 9단계 가상 사건 계약은 at, method, identity.sub만 제공합니다.
// 네트워크·기기·요청 본문 등 계약 밖의 값은 읽지 않습니다.
const WINDOW_MS = 10 * 60 * 1000;
const READ_LIMIT = 120;
const PSEUDONYMOUS_SUBJECT = /^[A-Za-z0-9_-]{1,128}$/u;

export function detect(events) {
  if (!Array.isArray(events)) throw new TypeError('invalid_detection_events');

  const readsBySubject = new Map();
  for (const event of events) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) continue;

    const timestamp = typeof event.at === 'string' ? Date.parse(event.at) : Number.NaN;
    const subject = event.identity?.sub;
    if (!Number.isFinite(timestamp) || event.method !== 'GET'
        || typeof subject !== 'string' || !PSEUDONYMOUS_SUBJECT.test(subject)) continue;

    const reads = readsBySubject.get(subject) ?? [];
    reads.push(timestamp);
    readsBySubject.set(subject, reads);
  }

  let earliestCandidate = null;
  for (const [subject, reads] of readsBySubject) {
    reads.sort((left, right) => left - right);
    let windowStart = 0;
    for (let windowEnd = 0; windowEnd < reads.length; windowEnd += 1) {
      while (reads[windowEnd] - reads[windowStart] > WINDOW_MS) windowStart += 1;
      if (windowEnd - windowStart + 1 <= READ_LIMIT) continue;

      const candidate = { subject, at: reads[windowEnd] };
      if (earliestCandidate === null || candidate.at < earliestCandidate.at) earliestCandidate = candidate;
      break;
    }
  }

  if (earliestCandidate !== null) {
    return {
      action: 'propose_revocation',
      reasonCode: 'burst_read',
      subject: earliestCandidate.subject,
    };
  }

  return { action: 'observe' };
}
