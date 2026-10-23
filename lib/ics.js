// iCalendar (RFC 5545) for the 'Add to calendar' link: CRLF line endings, 75-octet folding,
// TEXT escaping, UID + DTSTAMP, TZID America/New_York (with VTIMEZONE) or floating local time for any other
// TIMEZONE, or an all-day event when there is no time.
const icsEsc = s => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
function icsFold(line) { // RFC 5545: lines of at most 75 octets, continuation lines start with one space
  const enc = new TextEncoder(), out = []; let cur = '', n = 0;
  for (const ch of line) {
    const l = enc.encode(ch).length;
    if (n + l > (out.length ? 74 : 75)) { out.push(cur); cur = ''; n = 0; }
    cur += ch; n += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}
// Party date -> [y, m, d], or null if it can't be read (then no calendar file is offered; never a guessed date).
// ISO 2026-10-29; 10/29/2026, 10/29/26, 10/29, 10-29-2026; Oct 29, October 29, 2026, Thursday, October 29, 2026,
// Oct. 29th; 29 October 2026. A missing year means this year. The date must exist (no Feb 30).
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const DEFAULT_YEAR = () => new Date().getUTCFullYear();
export function parsePartyDate(s, defaultYear = DEFAULT_YEAR()) {
  const t = String(s || '').toLowerCase().trim();
  const ok = (y, mo, d) => {
    y = y === undefined ? defaultYear : y < 100 ? 2000 + y : y;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return y >= 2000 && y <= 2100 && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? [y, mo, d] : null;
  };
  const yr = v => (v === undefined ? undefined : +v);
  let m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = t.match(/(?:^|[^\d/.-])(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?(?![\d/.-])/);
  if (m) return ok(yr(m[3]), +m[1], +m[2]);
  m = t.match(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`));
  if (m) return ok(yr(m[3]), MONTHS.indexOf(m[1].slice(0, 3)) + 1, +m[2]);
  m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`));
  if (m) return ok(yr(m[3]), MONTHS.indexOf(m[2].slice(0, 3)) + 1, +m[1]);
  return null;
}
// "1:30 PM", "1:30-3 pm", "10am to 11:15am", "13:00". Returns [[h,m],[h,m]] or null (then all-day).
export function parsePartyTime(s) {
  const t = String(s || '').toLowerCase().replace(/\./g, '');
  const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g, parts = [];
  let m; while ((m = re.exec(t)) && parts.length < 2) parts.push(m);
  if (!parts.length || !/\d/.test(t) || /tbd/.test(t)) return null;
  const mer = parts.map(p => p[3]), last = mer[1] || mer[0];
  const conv = (p, md) => {
    let h = +p[1]; const mi = +(p[2] || 0);
    if (mi > 59 || h > 23) return null;
    if (md === 'pm' && h < 12) h += 12; else if (md === 'am' && h === 12) h = 0;
    else if (!md && h >= 1 && h <= 7) h += 12; // school-day guess: "2:00" means 2 PM
    return [h, mi];
  };
  const a = conv(parts[0], mer[0] || last); if (!a) return null;
  let b = parts[1] ? conv(parts[1], mer[1] || mer[0]) : null;
  if (!b || b[0] * 60 + b[1] <= a[0] * 60 + a[1]) b = [a[0] + 1, a[1]];
  return b[0] > 23 ? [a, [23, 59]] : [a, b];
}
// Returns null when the party date can't be read (the endpoint then answers 422).
export function buildIcs({ name, items, date, time, now = new Date(), uid, host = 'signup.local', origin = '', title = 'Class event', location = '', tz = 'America/New_York' }) {
  const pd = parsePartyDate(date); if (!pd) return null;
  const [y, mo, d] = pd, tm = parsePartyTime(time);
  const p2 = n => String(n).padStart(2, '0'), ymd = `${y}${p2(mo)}${p2(d)}`;
  const next = new Date(Date.UTC(y, mo - 1, d + 1)), ymd2 = `${next.getUTCFullYear()}${p2(next.getUTCMonth() + 1)}${p2(next.getUTCDate())}`;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const what = items.length ? items.join(', ') : 'something';
  const ny = tz === 'America/New_York';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Class sign-up template//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (tm && ny) lines.push('BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE');
  lines.push('BEGIN:VEVENT', `UID:${uid}@${host}`, `DTSTAMP:${stamp}`);
  const tzp = ny ? ';TZID=America/New_York' : ''; // other zones: floating local time (the phone's own clock)
  if (tm) lines.push(`DTSTART${tzp}:${ymd}T${p2(tm[0][0])}${p2(tm[0][1])}00`, `DTEND${tzp}:${ymd}T${p2(tm[1][0])}${p2(tm[1][1])}00`);
  else lines.push(`DTSTART;VALUE=DATE:${ymd}`, `DTEND;VALUE=DATE:${ymd2}`);
  lines.push(`SUMMARY:${icsEsc(title)}`, ...(location ? [`LOCATION:${icsEsc(location)}`] : []),
    `DESCRIPTION:${icsEsc(`${name ? name + ' is' : 'You are'} bringing: ${what}.${tm ? '' : ' Time: ' + (time || 'TBD') + '.'}${origin ? '\nSign-up page: ' + origin + '/' : ''}`)}`,
    'TRANSP:TRANSPARENT', 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
