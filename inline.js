// Fast inline renderer: renders one inline run (a paragraph's text, a heading's
// text, a table cell, a link label, ...) to exactly the HTML that marked
// 18.1.3's inline lexer + renderer produce for it, but with hand-written
// scanners instead of marked's regexes. Anything this module cannot prove
// is bails out via Bail so the caller can fall back to marked itself.
//
// The algorithms mirror marked's observable behaviour (CommonMark emphasis
// with its masking, link parsing with balanced parens, GFM autolinks); the
// code below is written from scratch for this entry.

export class Bail extends Error {}

// ---------------------------------------------------------------------------
// Character classification. ASCII is table-driven; anything else goes
// through the Unicode regexes (the same classes CommonMark uses).
// ---------------------------------------------------------------------------

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const ASCII_PUNCT_ESCAPE = ASCII_PUNCT; // same set: backslash escapes
// ASCII lookup tables (index by char code) — faster than Set.has on the
// hottest paths.
function tableFrom(chars) {
  const t = new Uint8Array(128);
  for (const ch of chars) t[ch.charCodeAt(0)] = 1;
  return t;
}
const PUNCT_TABLE = tableFrom('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const EMAIL_TABLE = tableFrom('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?^_`{|}~-');
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const ALNUM = /[\p{L}\p{N}]/u;
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const UNICODE_SPACE = /\s/u;

function isSpace(ch) {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') return true;
  return ch > '\x7f' && UNICODE_SPACE.test(ch);
}
function isPunct(ch) {
  if (ch < '\x80') return PUNCT_TABLE[ch.charCodeAt(0)] === 1;
  return UNICODE_PUNCT.test(ch);
}
// GFM emphasis/strikethrough treat `~` as a normal character, not punctuation.
function isPunctGfm(ch) {
  if (ch === '~') return false;
  return isPunct(ch);
}
function isWordChar(ch) {
  if (ch < '\x80') return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_';
  return WORD_CHAR.test(ch);
}
function isAlnum(ch) {
  if (ch < '\x80') return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
  return ALNUM.test(ch);
}
function isEmailChar(ch) {
  if (ch < '\x80') return EMAIL_TABLE[ch.charCodeAt(0)] === 1;
  return false;
}

// ---------------------------------------------------------------------------
// HTML helpers (same observable behaviour as marked's helpers).
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

export function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (ESCAPE_TEST.test(html)) return html.replace(ESCAPE_REPLACE, (ch) => ESCAPE_MAP[ch]);
  } else {
    if (ESCAPE_TEST_NO_ENCODE.test(html)) return html.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

const NUMERIC_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

export function decodeNumericCharacterReferences(text) {
  if (!NUMERIC_REF_TEST.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

const PERCENT_DECODE = /%25/g;
export function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(PERCENT_DECODE, '%');
  } catch {
    return null;
  }
  return href;
}

const MULTI_SPACE = /\s+/g;
export function normalizeLabel(label) {
  return label.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

export function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

export function rtrim(str, c) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l && str.charAt(l - suffLen - 1) === c) suffLen++;
  return str.slice(0, l - suffLen);
}

// Unescape `\[` and `\]` inside a link label (marked's outputLinkReplace).
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
function unescapeLabelBrackets(text) {
  return text.replace(OUTPUT_LINK_REPLACE, '$1');
}

// Unescape `\punct` -> punct (marked's inline.anyPunctuation, `$1`).
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
function unescapePunct(text) {
  return text.replace(ANY_PUNCT, '$1');
}

// ---------------------------------------------------------------------------
// Code spans. Returns {end, text} or null.
// ---------------------------------------------------------------------------

export function scanCodespan(src, i) {
  // count the opening backtick run
  let k = 0;
  while (i + k < src.length && src[i + k] === '`') k++;
  if (k === 0) return null;
  // find the earliest later backtick run of exactly k, with content >= 1 char
  let j = i + k;
  while (j < src.length) {
    if (src[j] !== '`') { j++; continue; }
    let m = 0;
    while (j + m < src.length && src[j + m] === '`') m++;
    if (m === k && j > i + k) {
      let text = src.slice(i + k, j).replace(/\n/g, ' ');
      if (/[^ ]/.test(text) && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ') {
        text = text.substring(1, text.length - 1);
      }
      return { end: j + m, text };
    }
    j += m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline HTML tags. Returns the tag text or null. Also reports the tag kind
// for the inLink / inRawBlock state updates.
// ---------------------------------------------------------------------------

function scanAttribute(src, i) {
  // src[i] starts an attribute name; returns end index or -1.
  const n = src.length;
  if (i >= n) return -1;
  const c = src[i];
  if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === ':' || c === '_')) return -1;
  let j = i + 1;
  while (j < n) {
    const d = src[j];
    if ((d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || (d >= '0' && d <= '9') || d === '_' || d === ':' || d === '.' || d === '-') j++;
    else break;
  }
  // optional = value
  let k = j;
  while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k++;
  if (src[k] === '=') {
    k++;
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k++;
    if (src[k] === '"') {
      const end = src.indexOf('"', k + 1);
      if (end === -1) return -1;
      return end + 1;
    }
    if (src[k] === "'") {
      const end = src.indexOf("'", k + 1);
      if (end === -1) return -1;
      return end + 1;
    }
    // unquoted value: no whitespace, quote, =, <, > or backtick
    let m = k;
    while (m < n) {
      const d = src[m];
      if (d === ' ' || d === '\t' || d === '\n' || d === '\r' || d === '"' || d === "'" || d === '=' || d === '<' || d === '>' || d === '`') break;
      m++;
    }
    if (m === k) return -1;
    return m;
  }
  return j;
}

export function scanTag(src, i) {
  const n = src.length;
  if (src[i] !== '<') return null;
  // comment <!-- ... -->
  if (src.startsWith('<!--', i)) {
    if (src[i + 4] === '>') return { end: i + 5, text: src.slice(i, i + 5) };
    if (src[i + 4] === '-' && src[i + 5] === '>') return { end: i + 6, text: src.slice(i, i + 6) };
    const end = src.indexOf('-->', i + 4);
    if (end === -1) return null;
    return { end: end + 3, text: src.slice(i, end + 3) };
  }
  // closing tag </name>
  if (src[i + 1] === '/') {
    let j = i + 2;
    if (j >= n || !((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) return null;
    j++;
    while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '-')) j++;
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
    if (src[j] !== '>') return null;
    return { end: j + 1, text: src.slice(i, j + 1) };
  }
  // processing instruction <? ... ?>
  if (src[i + 1] === '?') {
    const end = src.indexOf('?>', i + 2);
    if (end === -1) return null;
    return { end: end + 2, text: src.slice(i, end + 2) };
  }
  // declaration <!Letter ...> or CDATA <![CDATA[ ... ]]>
  if (src[i + 1] === '!') {
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end === -1) return null;
      return { end: end + 3, text: src.slice(i, end + 3) };
    }
    let j = i + 2;
    if (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) {
      j++;
      while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) j++;
      if (j >= n || !isSpace(src[j])) return null;
      const end = src.indexOf('>', j);
      if (end === -1) return null;
      return { end: end + 1, text: src.slice(i, end + 1) };
    }
    return null;
  }
  // open tag <name ...>
  if ((src[i + 1] >= 'a' && src[i + 1] <= 'z') || (src[i + 1] >= 'A' && src[i + 1] <= 'Z')) {
    let j = i + 1;
    j++;
    while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '-')) j++;
    for (;;) {
      // skip whitespace; an attribute needs at least one whitespace char
      // before it (the tag regex is \s+attr, not attr)
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k++;
      if (src[k] === '>') return { end: k + 1, text: src.slice(i, k + 1) };
      if (src[k] === '/' && src[k + 1] === '>') return { end: k + 2, text: src.slice(i, k + 2) };
      if (k === j) return null;
      const attrEnd = scanAttribute(src, k);
      if (attrEnd === -1) return null;
      j = attrEnd;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Autolinks <scheme:...> and <email>. Returns {end, text, href} or null.
// ---------------------------------------------------------------------------

function scanDomainLabel(src, i) {
  // [a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])? — longest valid label.
  const n = src.length;
  if (i >= n) return -1;
  const c = src[i];
  if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return -1;
  let j = i + 1;
  let run = 0;
  while (j < n && run < 62 && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '-')) { j++; run++; }
  // backtrack so the label ends on an alphanumeric
  while (j > i + 1 && !((src[j - 1] >= 'a' && src[j - 1] <= 'z') || (src[j - 1] >= 'A' && src[j - 1] <= 'Z') || (src[j - 1] >= '0' && src[j - 1] <= '9'))) j--;
  return j;
}

const EMAIL_LOCAL = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?^_`{|}~-'.split(''));

export function scanAutolink(src, i) {
  // src[i] === '<'
  const n = src.length;
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31} : [^\s\x00-\x1f<>]* >
  let j = i + 1;
  if (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) {
    let k = j + 1;
    let count = 0;
    while (k < n && count < 31 && ((src[k] >= 'a' && src[k] <= 'z') || (src[k] >= 'A' && src[k] <= 'Z') || (src[k] >= '0' && src[k] <= '9') || src[k] === '+' || src[k] === '.' || src[k] === '-')) { k++; count++; }
    if (count >= 1 && src[k] === ':') {
      let m = k + 1;
      while (m < n) {
        const cc = src.charCodeAt(m);
        if (src[m] === ' ' || src[m] === '\t' || src[m] === '\n' || src[m] === '\r' || cc < 0x20 || src[m] === '<' || src[m] === '>') break;
        m++;
      }
      if (src[m] === '>') {
        const text = src.slice(i + 1, m);
        return { end: m + 1, text, href: text };
      }
    }
  }
  // email: local@domain>
  j = i + 1;
  let k = j;
  while (k < n && EMAIL_LOCAL.has(src[k])) k++;
  if (k > j && src[k] === '@') {
    let m = scanDomainLabel(src, k + 1);
    if (m !== -1) {
      let ok = false;
      while (src[m] === '.') {
        const next = scanDomainLabel(src, m + 1);
        if (next === -1) break;
        m = next;
        ok = true;
      }
      if (ok && src[m] !== '-' && src[m] !== '_' && src[m] === '>') {
        const text = src.slice(i + 1, m);
        return { end: m + 1, text, href: 'mailto:' + text };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extended autolinks (GFM url). Only tried when !state.inLink.
// Returns {end, text, href} or null.
// ---------------------------------------------------------------------------

const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

function backpedal(s) {
  // Marked applies the backpedal until the result stops changing.
  let prev;
  do {
    prev = s;
    const m = BACKPEDAL.exec(s);
    s = m ? m[0] : '';
  } while (prev !== s);
  return s;
}

function isUrlDomainChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-';
}

// email domain for extended autolinks: label(.label)+ with _ allowed, no caps.
function scanExtEmailDomain(src, i) {
  const n = src.length;
  let j = i;
  if (j >= n || !isUrlDomainChar(src[j]) && src[j] !== '_') return -1;
  while (j < n && (isUrlDomainChar(src[j]) || src[j] === '_')) j++;
  let groups = 0;
  while (src[j] === '.') {
    let k = j + 1;
    const start = k;
    while (k < n && (isUrlDomainChar(src[k]) || src[k] === '_')) k++;
    if (k === start) break;
    // last char of the label must be alnum
    let end = k;
    while (end > start && !((src[end - 1] >= 'a' && src[end - 1] <= 'z') || (src[end - 1] >= 'A' && src[end - 1] <= 'Z') || (src[end - 1] >= '0' && src[end - 1] <= '9'))) end--;
    if (end === start) break;
    j = end;
    groups++;
  }
  if (groups === 0) return -1;
  // (?![\w-]) — \w is ASCII-only [A-Za-z0-9_], not Unicode word chars
  if (j < n) {
    const c = src[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-') return -1;
  }
  return j;
}

function scanExtEmail(src, i) {
  // [A-Za-z0-9._+-]+ @ domain  — returns end or -1
  const n = src.length;
  let j = i;
  const start = j;
  while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '.' || src[j] === '_' || src[j] === '+' || src[j] === '-')) j++;
  if (j === start || src[j] !== '@') return -1;
  return scanExtEmailDomain(src, j + 1);
}

export function scanUrl(src, i) {
  const n = src.length;
  // mailto: / xmpp: + email
  if (src.startsWith('mailto:', i) || src.startsWith('xmpp:', i)) {
    const protoLen = src.startsWith('mailto:', i) ? 7 : 5;
    const end = scanExtEmail(src, i + protoLen);
    if (end !== -1) {
      let e = end;
      if (src.startsWith('xmpp:', i) && src[e] === '/') {
        let k = e + 1;
        while (k < n && ((src[k] >= 'a' && src[k] <= 'z') || (src[k] >= 'A' && src[k] <= 'Z') || (src[k] >= '0' && src[k] <= '9') || src[k] === '@' || src[k] === '.')) k++;
        if (k > e + 1) e = k;
      }
      const text = src.slice(i, e);
      return { end: e, text, href: text };
    }
  }
  // scheme:// (case-insensitive) or www. (lowercase only) + domain labels
  const lower = src.slice(i, i + 8).toLowerCase();
  let schemeEnd = -1;
  let isWww = false;
  if (lower.startsWith('http://')) schemeEnd = i + 7;
  else if (lower.startsWith('https://')) schemeEnd = i + 8;
  else if (lower.startsWith('ftp://')) schemeEnd = i + 6;
  else if (src.startsWith('www.', i)) { schemeEnd = i + 4; isWww = true; }
  if (schemeEnd !== -1) {
    let j = schemeEnd;
    if (j >= n || !isUrlDomainChar(src[j])) return null;
    // (?:[a-zA-Z0-9-]+\.?)+ then [^\s<]*
    while (j < n) {
      if (isUrlDomainChar(src[j])) { j++; continue; }
      if (src[j] === '.' && j + 1 < n && isUrlDomainChar(src[j + 1])) { j++; continue; }
      break;
    }
    while (j < n && src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n' && src[j] !== '\r' && src[j] !== '\f' && src[j] !== '\v' && src[j] !== '<') j++;
    let text = backpedal(src.slice(i, j));
    if (!text) return null;
    return { end: i + text.length, text, href: isWww ? 'http://' + text : text };
  }
  // plain email
  const end = scanExtEmail(src, i);
  if (end !== -1) {
    const text = src.slice(i, end);
    return { end, text, href: 'mailto:' + text };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Link labels. scanLabel(src, i) with src[i] === '[' returns {end, text}
// where end is just past the closing ']' and text is the raw label content,
// or null if no label closes here. Nested brackets go two levels deep (the
// same depth marked's label grammar allows); backslash escapes and code
// spans are skipped over as units.
// ---------------------------------------------------------------------------

function scanBracketGroup(src, i) {
  // src[i] === '['; parse \[(?:brackets|\\.|[^\[\]\\])*\] — one more level.
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === ']') return j + 1;
    if (c === '\\') { j += 2; continue; }
    if (c === '[') {
      // one deeper level: \[(?:\\.|[^\[\]\\])*\]
      let k = j + 1;
      let closed = false;
      while (k < n) {
        const d = src[k];
        if (d === ']') { closed = true; break; }
        if (d === '\\') { k += 2; continue; }
        if (d === '[') return -1;
        k++;
      }
      if (!closed) return -1;
      j = k + 1;
      continue;
    }
    j++;
  }
  return -1;
}

function scanCodeInLabel(src, i) {
  // At a backtick run: the code alternative `+(?!`)[^`]*?`+(?!`) — returns the
  // end index past the closing run, or -1. A run of 2+ right before ']' is
  // the ``+(?=\]) alternative.
  const n = src.length;
  let k = 0;
  while (i + k < n && src[i + k] === '`') k++;
  if (k >= 2 && src[i + k] === ']') return i + k;
  let j = i + k;
  while (j < n) {
    if (src[j] !== '`') { j++; continue; }
    let m = 0;
    while (j + m < n && src[j + m] === '`') m++;
    return j + m;
  }
  return -1;
}

export function scanLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === ']') return { end: j + 1, text: src.slice(i + 1, j) };
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      const end = scanCodeInLabel(src, j);
      if (end === -1) return null;
      j = end;
      continue;
    }
    if (c === '[') {
      const end = scanBracketGroup(src, j);
      if (end === -1) return null;
      j = end;
      continue;
    }
    j++;
  }
  return null;
}

// Is the end of this label inside an HTML tag or autolink that starts in it?
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = scanCodespan(label, i);
      if (code) { i += (code.end - i) - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + 1 + i);
    const token = scanTag(tokenSrc, 0) || scanAutolink(tokenSrc, 0);
    if (!token) continue;
    if (token.end > label.length - i) return true;
    i += token.end - 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inline links [label](dest "title"). Returns {end, href, title, label,
// isImage} or null. The caller renders the label and applies the nested-link
// rule. Throws Bail on shapes too pathological to scan cheaply.
// ---------------------------------------------------------------------------

function skipWs(src, i) {
  const n = src.length;
  while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
  return i;
}

function scanTitle(src, i) {
  // Returns {end, title} or null. i is at the opening quote/paren.
  const n = src.length;
  const q = src[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === q) return { end: j + 1, title: src.slice(i + 1, j) };
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === ')') return { end: j + 1, title: src.slice(i + 1, j) };
      j++;
    }
    return null;
  }
  return null;
}

function scanRest(src, i) {
  // After the href: [ws + title] + ws + ')'  OR  ws + ')'.
  // Returns {end} where end is just past ')', or null.
  const n = src.length;
  // try with title first
  let j = i;
  if (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) {
    let k = j;
    if (src[k] === ' ' || src[k] === '\t') {
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (src[k] === '\n') {
        k++;
        while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      }
    } else if (src[k] === '\n') {
      k++;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
    }
    const title = scanTitle(src, k);
    if (title) {
      let m = skipWs(src, title.end);
      if (src[m] === ')') return { end: m + 1, title: title.title };
    }
  }
  // without title
  j = skipWs(src, i);
  if (src[j] === ')') return { end: j + 1, title: '' };
  return null;
}

export function scanLink(src, i) {
  const n = src.length;
  let j = i;
  let isImage = false;
  if (src[j] === '!') { isImage = true; j++; }
  if (src[j] !== '[') return null;
  const labelStart = j;
  const label = scanLabel(src, j);
  if (!label) return null;
  if (src[label.end] !== '(') return null;
  if (isLabelEndInsideToken(src, label.text, labelStart)) return null;

  let k = skipWs(src, label.end + 1);
  let href = '';
  let hrefStartAbs = k;
  let restStart;
  let angle = false;
  if (src[k] === '<') {
    // angle destination <(?:\\.|[^\n<>\\])+> — at least one char inside.
    // If it does not parse, the bare destination is tried instead.
    let m = k + 1;
    let ok = false;
    while (m < n) {
      const c = src[m];
      if (c === '\\') {
        const d = src[m + 1];
        if (d === '\n' || d === '\r' || d === '\u2028' || d === '\u2029' || d === undefined) break;
        m += 2;
        continue;
      }
      if (c === '>') { ok = m > k + 1; break; }
      if (c === '\n' || c === '<') break;
      m++;
    }
    if (ok) {
      href = src.slice(k + 1, m);
      restStart = m + 1;
      angle = true;
    }
  }
  if (!angle) {
    if (src[k] === ')') {
      href = '';
      restStart = k;
    } else {
      // bare destination: maximal run, then backtrack to the longest href that
      // lets the rest (optional title + ')') match.
      let m = k;
      while (m < n) {
        const cc = src.charCodeAt(m);
        if (src[m] === ' ' || src[m] === '\t' || src[m] === '\n' || cc < 0x20) break;
        m++;
      }
      if (m - k > 2000) throw new Bail();
      for (let e = m; e > k; e--) {
        const rest = scanRest(src, e);
        if (rest) return finishLink(src, i, isImage, label, src.slice(k, e), rest.title, rest.end, false, hrefStartAbs);
      }
      return null;
    }
  }
  // angle / empty href: rest is optional title + ws + ')'
  const rest = scanRest(src, restStart);
  if (!rest) return null;
  return finishLink(src, i, isImage, label, href, rest.title, rest.end, angle, hrefStartAbs);
}

function finishLink(src, i, isImage, label, href, title, end, angle, hrefStartAbs) {
  // A bare destination starting with '<' must end with an unescaped '>'.
  if (!angle && href !== '') {
    const trimmed = href.trim();
    if (trimmed.startsWith('<')) {
      if (!trimmed.endsWith('>')) return null;
      const noGt = rtrim(trimmed.slice(0, -1), '\\');
      if ((trimmed.length - noGt.length) % 2 === 0) return null;
    }
  }
  // findClosingBracket on a bare href: truncate at an unmatched ')'.
  if (!angle && href !== '') {
    const lastParen = findClosingBracket(href, '()');
    if (lastParen === -2) return null;
    if (lastParen > -1) {
      href = href.substring(0, lastParen);
      // marked truncates cap[0] to start + label.length + lastParen, where
      // start is 4 (or 5 for an image) — measured from the link's start,
      // ignoring any whitespace after '('.
      end = i + (isImage ? 5 : 4) + label.text.length + lastParen;
      title = '';
    }
  }
  // the closing ')' must not be escaped (odd backslashes before it)
  let b = 0;
  let p = end - 2;
  while (p >= i && src[p] === '\\') { b++; p--; }
  if (b % 2 === 1) return null;
  // a destination starting with '<' has its angle brackets stripped
  if (href.startsWith('<')) href = href.slice(1, -1);
  return { end, href, title, label: label.text, isImage, raw: src.slice(i, end) };
}

// ---------------------------------------------------------------------------
// Reference links [label][ref], [label][], [label]. Returns {end, href,
// title, label, isImage}, {textChar} when the reference is not defined
// (a single-character text token), or null when nothing matches here.
// ---------------------------------------------------------------------------

function scanBlockLabel(src, i) {
  // _blockLabel: (?!\s*\])(?:\\[\s\S]|[^\[\]\\]|\n(?![ \t]*\n))+
  // (the [^\[\]\\] alternative also matches newlines, so the third is dead)
  const n = src.length;
  let j = i;
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r' || src[j] === '\f' || src[j] === '\v')) j++;
  if (src[j] === ']') return null;
  let k = i;
  let count = 0;
  while (k < n) {
    const c = src[k];
    if (c === '[' || c === ']') break;
    if (c === '\\') { if (k + 1 >= n) break; k += 2; count++; continue; }
    k++;
    count++;
  }
  if (count === 0) return null;
  return k;
}

export function scanReflink(src, i, links) {
  const n = src.length;
  let j = i;
  let isImage = false;
  if (src[j] === '!') { isImage = true; j++; }
  if (src[j] !== '[') return null;
  const labelStart = j;
  // reflink form: [inlineLabel][blockLabel]
  const label = scanLabel(src, j);
  if (label) {
    if (isLabelEndInsideToken(src, label.text, labelStart)) return null;
    if (src[label.end] === '[') {
      const r = scanBlockLabel(src, label.end + 1);
      if (r !== null && src[r] === ']') {
        const ref = src.slice(label.end + 1, r);
        const link = links[normalizeLabel(ref)];
        if (!link) return { textChar: src[i] };
        return { end: r + 1, href: link.href, title: link.title || '', label: label.text, isImage };
      }
    }
  }
  // nolink form: [blockLabel] or [blockLabel][]
  const r = scanBlockLabel(src, j + 1);
  if (r === null || src[r] !== ']') return null;
  const refText = src.slice(j + 1, r);
  if (isLabelEndInsideToken(src, refText, labelStart)) return null;
  let end = r + 1;
  if (src[end] === '[' && src[end + 1] === ']') end += 2;
  const link = links[normalizeLabel(refText)];
  if (!link) return { textChar: src[i] };
  return { end, href: link.href, title: link.title || '', label: refText, isImage };
}

// ---------------------------------------------------------------------------
// Masking: hide link/code/html/escape delimiters from emphasis scanning.
// Produces a string of the same length as src.
// ---------------------------------------------------------------------------

function linkInText(text, links) {
  if (!text.includes('[')) return false;
  // blockSkip matches, left to right: inline link, code span, html tag.
  // Only a link candidate that is a real link (and not an image) counts.
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '`') {
      const code = scanCodespan(text, i);
      if (code) { i = code.end; continue; }
      i++;
      continue;
    }
    if (c === '<') {
      if (text[i + 1] !== ' ') {
        let gt = -1;
        for (let k = i + 1; k < text.length; k++) {
          if (text[k] === '>') { gt = k; break; }
          if (text[k] === '<') break;
        }
        if (gt !== -1) { i = gt + 1; continue; }
      }
      i++;
      continue;
    }
    if (c === '[') {
      const loose = looseLinkEnd(text, i);
      if (loose !== -1) {
        if (scanLink(text, i) && text.charAt(i - 1) !== '!') return true;
        i = loose;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  // reflink candidates resolving in links
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c !== '[' && !(c === '!' && text[k + 1] === '[')) continue;
    const cand = reflinkCandidate(text, k, links);
    if (!cand) continue;
    const { match0, refStart } = cand;
    k += match0.length - 1;
    if (match0.charAt(0) === '!') continue;
    if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), links)) continue;
    return true;
  }
  return false;
}

// Loose blockSkip link: \[(label without nesting)\]\(...parens, 1 level...\)
function looseLinkEnd(src, i) {
  const n = src.length;
  if (src[i] !== '[') return -1;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === ']') break;
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      const code = scanCodespan(src, j);
      if (!code) return -1;
      j = code.end;
      continue;
    }
    if (c === '[') return -1;
    j++;
  }
  if (j >= n || src[j] !== ']' || src[j + 1] !== '(') return -1;
  let k = j + 2;
  let depth = 0;
  while (k < n) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '(') { depth++; if (depth > 1) return -1; k++; continue; }
    if (c === ')') {
      if (depth === 0) return k + 1;
      depth--;
      k++;
      continue;
    }
    k++;
  }
  return -1;
}

// A reflink/nolink candidate for masking (bounded labels, as reflinkSearch).
function reflinkCandidate(src, i, links) {
  const n = src.length;
  let j = i;
  if (src[j] === '!') j++;
  if (src[j] !== '[') return null;
  const label = scanLabel(src, j);
  if (!label) return null;
  if (src[label.end] === '[') {
    const r = scanBlockLabel(src, label.end + 1);
    if (r !== null && src[r] === ']') {
      return { match0: src.slice(i, r + 1), refStart: label.end - i };
    }
  }
  // nolink
  const r = scanBlockLabel(src, j + 1);
  if (r === null || src[r] !== ']') return null;
  let end = r + 1;
  if (src[end] === '[' && src[end + 1] === ']') end += 2;
  return { match0: src.slice(i, end), refStart: 0 };
}

export function maskSrc(src, links) {
  let masked = src;
  // Step 1: mask reflinks (only when definitions exist)
  if (links && Object.keys(links).length > 0 && src.includes('[')) {
    let out = '';
    let i = 0;
    while (i < masked.length) {
      const c = masked[i];
      if (c === '[' || (c === '!' && masked[i + 1] === '[')) {
        const cand = reflinkCandidate(masked, i, links);
        if (cand) {
          const { match0, refStart } = cand;
          const resolves = Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)));
          if (resolves) {
            if (refStart > 1 && match0.charAt(0) !== '!') {
              const text = match0.slice(1, refStart - 1);
              if (linkInText(text, links)) {
                out += '[' + maskReflinksOnly(text, links) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
                i += match0.length;
                continue;
              }
            }
            out += '[' + 'a'.repeat(match0.length - 2) + ']';
            i += match0.length;
            continue;
          }
          // found but unresolved: the regex consumes the match as a unit
          i += match0.length;
          out += match0;
          continue;
        }
      }
      out += c;
      i++;
    }
    masked = out;
  }
  // Step 2: mask escapes, code spans, inline links and html tags in one
  // pass (marked does escapes+code first, then blockSkip, but the two only
  // interact where one construct contains another, and this pass handles
  // each construct as a unit in document order, so the result is the same).
  // Jumps between the interesting characters with indexOf; the text between
  // them is copied as one slice.
  {
    const parts = [];
    let i = 0;
    const n = masked.length;
    while (i < n) {
      let next = n;
      const bs = masked.indexOf('\\', i);
      if (bs !== -1 && bs < next) next = bs;
      const bt = masked.indexOf('`', i);
      if (bt !== -1 && bt < next) next = bt;
      const br = masked.indexOf('[', i);
      if (br !== -1 && br < next) next = br;
      const lt = masked.indexOf('<', i);
      if (lt !== -1 && lt < next) next = lt;
      if (next === n) { parts.push(masked.slice(i)); break; }
      if (next > i) parts.push(masked.slice(i, next));
      i = next;
      const c = masked[i];
      if (c === '\\' && i + 1 < n && isPunct(masked[i + 1])) {
        parts.push('++');
        i += 2;
        continue;
      }
      if (c === '`') {
        const code = scanCodespan(masked, i);
        if (code) {
          parts.push('[', 'a'.repeat(code.end - i - 2), ']');
          i = code.end;
          continue;
        }
        // No code span starts here, and none can start later in this run
        // (a run is masked as a unit; marked's blockSkip forbids a span
        // starting right after a backtick). Emit the whole run.
        let run = 0;
        while (i + run < n && masked[i + run] === '`') run++;
        parts.push('`'.repeat(run));
        i += run;
        continue;
      }
      if (c === '[') {
        const end = looseLinkEnd(masked, i);
        if (end !== -1) {
          parts.push('[', 'a'.repeat(end - i - 2), ']');
          i = end;
          continue;
        }
      } else if (c === '<') {
        if (masked[i + 1] !== ' ') {
          let gt = -1;
          for (let k = i + 1; k < n; k++) {
            if (masked[k] === '>') { gt = k; break; }
            if (masked[k] === '<') break;
          }
          if (gt !== -1) {
            parts.push('[', 'a'.repeat(gt - i - 1), ']');
            i = gt + 1;
            continue;
          }
        }
      }
      parts.push(c);
      i++;
    }
    masked = parts.join('');
  }
  return masked;
}

// Mask only reflinks inside text (used for a reflink whose text holds a link).
function maskReflinksOnly(text, links) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const cand = reflinkCandidate(text, i, links);
      if (cand) {
        const { match0, refStart } = cand;
        if (Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
          if (refStart > 1 && match0.charAt(0) !== '!') {
            const inner = match0.slice(1, refStart - 1);
            if (linkInText(inner, links)) {
              out += '[' + maskReflinksOnly(inner, links) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
              i += match0.length;
              continue;
            }
          }
          out += '[' + 'a'.repeat(match0.length - 2) + ']';
          i += match0.length;
          continue;
        }
        // found but unresolved: the regex consumes the match as a unit
        out += match0;
        i += match0.length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emphasis / strong / strikethrough.
// ---------------------------------------------------------------------------

// Last index of a run that can close emphasis/strong (`*`/`_`) or
// strikethrough (`~`) in the masked source: a run not preceded by ASCII
// whitespace or the start of the string.
function scanLastClosers(masked) {
  const last = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      last[ch] = i;
    }
    i = j - 1;
  }
  return last;
}

// marked's inline.punctuation: a space or punctuation character, except
// `*` and `_` (which the regex's (?![*_]) lookahead excludes).
function isFlankPunct(ch) {
  if (ch === '' || ch === undefined) return false;
  if (ch === '*' || ch === '_') return false;
  return isSpace(ch) || isPunct(ch);
}

// Classify a delimiter run [rs, re) in the masked source: 'left' (can only
// open), 'right' (can only close), 'either', or null (neither). gfm=true
// for `*`/`_` (where `~` is not punctuation), false for `~`. Note `_` has
// no group 6: a run between two alphanumerics can neither open nor close.
function classifyDelim(masked, rs, re, gfm, delim) {
  const prev = rs > 0 ? masked[rs - 1] : '';
  const next = re < masked.length ? masked[re] : '';
  const prevSpace = prev !== '' && isSpace(prev);
  const prevPunct = prev !== '' && (gfm ? isPunctGfm(prev) : isPunct(prev));
  const prevOther = prev !== '' && !prevSpace && !prevPunct;
  const nextSpace = next !== '' && isSpace(next);
  const nextPunct = next !== '' && (gfm ? isPunctGfm(next) : isPunct(next));
  const nextOther = next !== '' && !nextSpace && !nextPunct;
  const nextEnd = next === '';
  if (prevPunct && (nextSpace || nextEnd)) return 'right';
  if (prevOther && (nextPunct || nextSpace || nextEnd)) return 'right';
  if ((prevPunct || prevSpace) && nextOther) return 'left';
  if (prevSpace && nextPunct) return 'left';
  if (prevPunct && nextPunct) return 'either';
  if (delim !== '_' && prevOther && nextOther) return 'either';
  return null;
}

// Skip an orphan delimiter inside a strong span at the start of the closer
// window: `__...*...__` for `*`, `**..._...**` for `_`. Returns the position
// of the closing pair, or -1.
function orphanSkip(masked, windowStart, delim) {
  const n = masked.length;
  const pairCh = delim === '*' ? '_' : '*';
  const midCh = delim;
  let x = windowStart;
  while (x + 1 < n) {
    if (masked[x] === pairCh && masked[x + 1] === pairCh) break;
    if (masked[x] === '*' || masked[x] === '_') return -1;
    x++;
  }
  if (x + 1 >= n) return -1;
  let y = x + 2;
  while (y < n && masked[y] !== midCh) {
    if (masked[y] === '*' || masked[y] === '_') return -1;
    y++;
  }
  if (y >= n) return -1;
  let z = y + 1;
  while (z + 1 < n) {
    if (masked[z] === pairCh && masked[z + 1] === pairCh) return z;
    if (masked[z] === '*' || masked[z] === '_') return -1;
    z++;
  }
  return -1;
}

function tryEmStrong(src, pos, masked, lastClosers, prevChar) {
  const delim = src[pos];
  if (delim !== '*' && delim !== '_') return null;
  let lLength = 0;
  while (pos + lLength < src.length && src[pos + lLength] === delim) lLength++;
  const afterIdx = pos + lLength;
  const after = afterIdx < src.length ? src[afterIdx] : '';
  let nextPunct = null;
  let nextOther = null;
  if (after !== '') {
    if (isPunctGfm(after)) nextPunct = after;
    else if (!isSpace(after)) nextOther = after;
  }
  if (!nextPunct && !nextOther) return null;
  const midRun = prevChar === delim;
  let runStart = pos;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const runPrevChar = runStart > 0 ? masked[runStart - 1] : '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || isFlankPunct(runPrevChar);
  let effPrevChar = prevChar;
  if (runStart < pos) effPrevChar = runPrevChar;
  // Marked's gate uses h (which counts * and _ as "punctuation") when the
  // run extends back, and the punctuation test (which excludes * and _)
  // when it does not.
  const prevPunct = runStart < pos ? runPrevPunct : isFlankPunct(prevChar);
  if (delim === '_' && nextOther !== null && effPrevChar !== '' && isAlnum(effPrevChar)) return null;
  const nextChar = nextPunct || '';
  if (!nextChar || !effPrevChar || prevPunct) {
    const runLength = pos - runStart + lLength;
    const openerCanClose = runPrevChar !== '' && runPrevChar.trim() !== ''
      && (!!nextChar || (delim === '*' && !runPrevPunct));
    const windowStart = pos + lLength;
    const lastPossible = lastClosers[delim];
    if (lastPossible < windowStart) return null;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    let scanPos = windowStart;
    const orphan = orphanSkip(masked, windowStart, delim);
    if (orphan !== -1) scanPos = orphan;
    for (;;) {
      let rs = -1;
      for (let p = scanPos; p < masked.length; p++) {
        if (masked[p] === delim) { rs = p; break; }
      }
      if (rs === -1) return null;
      if (rs - 1 > lastPossible) return null;
      let re = rs;
      while (re < masked.length && masked[re] === delim) re++;
      const cls = classifyDelim(masked, rs, re, true, delim);
      scanPos = re;
      if (cls === null) continue;
      let rLength = re - rs;
      if (cls === 'left') {
        delimTotal += rLength;
        continue;
      }
      if (cls === 'either' || openerCanClose) {
        if (midRun && cls === 'either') return null;
        if (runLength % 3 !== 0 && (runLength + rLength) % 3 === 0) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const rawEnd = rs + rLength;
      const raw = src.slice(pos, rawEnd);
      if (Math.min(lLength, rLength) % 2 === 1) {
        return { end: rawEnd, tag: 'em', inner: raw.slice(1, -1) };
      }
      return { end: rawEnd, tag: 'strong', inner: raw.slice(2, -2) };
    }
  }
  return null;
}

function tryDel(src, pos, masked, lastClosers, prevChar) {
  if (src[pos] !== '~') return null;
  let lLength = 0;
  while (pos + lLength < src.length && src[pos + lLength] === '~') lLength++;
  if (lLength > 2) return null;
  const afterIdx = pos + lLength;
  const after = afterIdx < src.length ? src[afterIdx] : '';
  let nextPunct = null;
  let nextOther = null;
  if (after !== '') {
    if (isPunct(after)) nextPunct = after;
    else if (!isSpace(after) && after !== '~') nextOther = after;
  }
  if (!nextPunct && !nextOther) return null;
  const nextChar = nextPunct || '';
  if (!nextChar || !prevChar || isFlankPunct(prevChar)) {
    const windowStart = pos + lLength;
    const lastPossible = lastClosers['~'];
    if (lastPossible < windowStart) return null;
    let delimTotal = lLength;
    let scanPos = windowStart;
    for (;;) {
      let rs = -1;
      for (let p = scanPos; p < masked.length; p++) {
        if (masked[p] === '~') { rs = p; break; }
      }
      if (rs === -1) return null;
      if (rs - 1 > lastPossible) return null;
      let re = rs;
      while (re < masked.length && masked[re] === '~') re++;
      const cls = classifyDelim(masked, rs, re, false, '~');
      scanPos = re;
      if (cls === null) continue;
      let rLength = re - rs;
      if (rLength !== lLength) continue;
      if (cls === 'left') {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const rawEnd = rs + rLength;
      const raw = src.slice(pos, rawEnd);
      return { end: rawEnd, tag: 'del', inner: raw.slice(lLength, -lLength) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hard breaks: two or more spaces, or a backslash, before a newline, with
// non-whitespace following. Returns the end index or -1.
// ---------------------------------------------------------------------------

function scanBr(src, i) {
  const n = src.length;
  let j = i;
  if (src[j] === '\\') {
    j++;
  } else {
    let spaces = 0;
    while (j < n && src[j] === ' ') { j++; spaces++; }
    if (spaces < 2) return -1;
  }
  if (src[j] !== '\n') return -1;
  j++;
  let k = j;
  let allWs = true;
  while (k < n) {
    if (!isSpace(src[k])) { allWs = false; break; }
    k++;
  }
  if (allWs) return -1;
  while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
  return j;
}

// ---------------------------------------------------------------------------
// Plain-text runs: consume from i (first chunk unconditional) until a
// position where another inline construct could start.
// ---------------------------------------------------------------------------

// The text-run stop positions, as one regex (the same stops marked's text
// regex uses, read off its grammar): a construct-start character, a hard
// break, a www autolink (only after start / whitespace / * _ ~ (), the GFM
// rule, via the lookbehind), a scheme, mailto:/xmpp: (after a non-alnum),
// or an email address (at an email-character boundary). One C++ scan
// replaces a per-character JavaScript loop.
const TEXT_STOP = /[\\<!\[`*_~]| {2,}\n|(?<![^\s*_~(])www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|(?<![A-Za-z0-9])(?:mailto:|xmpp:)|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@/g;

// Case-insensitive http:// https:// ftp:// at src[j]; returns the scheme
// length (6, 7 or 8) or 0. Char-code compares, no string allocation.
function schemeLenAt(src, j) {
  const a = src.charCodeAt(j) | 32;
  const b = src.charCodeAt(j + 1) | 32;
  const c = src.charCodeAt(j + 2) | 32;
  const d = src.charCodeAt(j + 3) | 32;
  if (a === 104 && b === 116 && c === 116 && d === 112) { // http
    if (src.charCodeAt(j + 4) === 58) return 7; // http://
    if ((src.charCodeAt(j + 4) | 32) === 115 && src.charCodeAt(j + 5) === 58) return 8; // https://
  }
  if (a === 102 && b === 116 && c === 112 && src.charCodeAt(j + 3) === 58) return 6; // ftp://
  return 0;
}

function scanTextRun(src, i) {
  const n = src.length;
  let j = i + 1;
  if (src[i] === '`' || src[i] === '~') {
    while (j < n && src[j] === src[i]) j++;
  }
  TEXT_STOP.lastIndex = j;
  let m = TEXT_STOP.exec(src);
  // A mailto:/xmpp: stop right after a multi-character first chunk (a
  // backtick/tilde run) is not a stop: marked's mailto lookahead needs the
  // non-alphanumeric before it to be a character the text regex itself
  // consumes, and a run swallows it (`` ``mailto: `` stays text, only the
  // email inside linkifies). Skip such a match and keep scanning.
  while (m !== null && m.index === j && j > i + 1 && (m[0] === 'mailto:' || m[0] === 'xmpp:')) {
    TEXT_STOP.lastIndex = j + 1;
    m = TEXT_STOP.exec(src);
  }
  if (m === null) return n;
  return m.index;
}

// ---------------------------------------------------------------------------
// Links and images: tokenize the label once (for its state side effects),
// render it, apply the nested-link rule, then emit the HTML (or the plain
// text when plain=true, as an image's alt text or a text render needs).
// Returns the HTML string, or null when the link must fall back to text.
// ---------------------------------------------------------------------------

function renderLinkOrImage(link, links, state, plain) {
  const labelText = unescapeLabelBrackets(link.label);
  const outerInLink = state.inLink;
  const outerLinkEmitted = state.linkEmitted;
  const outerInRawBlock = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const rendered = renderInline(labelText, links, state, link.isImage ? true : plain);
  const textHasLink = state.linkEmitted;
  state.linkEmitted = outerLinkEmitted;
  state.inLink = outerInLink;
  if (!link.isImage) {
    if (textHasLink) {
      state.inRawBlock = outerInRawBlock;
      return null;
    }
    state.linkEmitted = true;
  }
  if (plain) return rendered;
  const href = unescapePunct(link.href);
  const title = link.title ? unescapePunct(link.title) : '';
  if (link.isImage) {
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return escapeHtmlEntities(rendered);
    let out = '<img src="' + escapeHtmlEntities(cleanHref) + '" alt="' + escapeHtmlEntities(rendered) + '"';
    if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
    out += '>';
    return out;
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return rendered;
  let out = '<a href="' + escapeHtmlEntities(cleanHref) + '"';
  if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
  out += '>' + rendered + '</a>';
  return out;
}

// Render an autolink / extended autolink ({text, href}).
function renderAutolink(auto, plain) {
  if (plain) return auto.text;
  const cleanHref = cleanUrl(auto.href);
  if (cleanHref === null) return escapeHtmlEntities(auto.text, true);
  return '<a href="' + escapeHtmlEntities(cleanHref, true) + '">' + escapeHtmlEntities(auto.text, true) + '</a>';
}

// ---------------------------------------------------------------------------
// The inline renderer: render src to HTML (plain=false) or to plain text
// (plain=true, for image alt text). state carries inLink / inRawBlock /
// linkEmitted across runs of one case; prevChar is local to this run.
// ---------------------------------------------------------------------------

export function renderInline(src, links, state, plain) {
  const n = src.length;
  let masked = null;
  let lastClosers = null;
  const getMasked = () => {
    if (masked === null) {
      // The mask only changes the string where a code span, link, html tag
      // or escape hides a delimiter; a run with none of those is already
      // its own mask.
      masked = (src.includes('[') || src.includes('`') || src.includes('<') || src.includes('\\'))
        ? maskSrc(src, links)
        : src;
    }
    return masked;
  };
  const getLastClosers = () => {
    if (lastClosers === null) lastClosers = scanLastClosers(getMasked());
    return lastClosers;
  };
  let out = '';
  let i = 0;
  let prevChar = '';
  let keepPrevChar = false;
  while (i < n) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[i];

    // escape: backslash + ASCII punctuation
    if (ch === '\\' && i + 1 < n && ASCII_PUNCT_ESCAPE.has(src[i + 1])) {
      const c = src[i + 1];
      out += plain ? c : escapeHtmlEntities(c);
      i += 2;
      continue;
    }

    // tag, then autolink (nothing else can start at '<')
    if (ch === '<') {
      const tag = scanTag(src, i);
      if (tag) {
        if (!state.inLink && /^<a /i.test(tag.text)) state.inLink = true;
        else if (state.inLink && /^<\/a>/i.test(tag.text)) state.inLink = false;
        if (!state.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag.text)) state.inRawBlock = true;
        else if (state.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag.text)) state.inRawBlock = false;
        out += tag.text;
        i = tag.end;
        continue;
      }
      const auto = scanAutolink(src, i);
      if (auto) {
        out += renderAutolink(auto, plain);
        i = auto.end;
        continue;
      }
      // fall through to text
    }

    // link, then reflink
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const link = scanLink(src, i);
      if (link) {
        const html = renderLinkOrImage(link, links, state, plain);
        if (html !== null) {
          out += html;
          i = link.end;
          continue;
        }
      }
      const ref = scanReflink(src, i, links);
      if (ref) {
        if (ref.textChar !== undefined) {
          out += plain ? ref.textChar : escapeHtmlEntities(ref.textChar);
          i++;
          continue;
        }
        const html = renderLinkOrImage(ref, links, state, plain);
        if (html !== null) {
          out += html;
          i = ref.end;
          continue;
        }
      }
      // fall through to text
    }

    // emphasis / strong
    if (ch === '*' || ch === '_') {
      const em = tryEmStrong(src, i, getMasked(), getLastClosers(), prevChar);
      if (em) {
        const inner = renderInline(em.inner, links, state, plain);
        out += plain ? inner : '<' + em.tag + '>' + inner + '</' + em.tag + '>';
        i = em.end;
        continue;
      }
    }

    // code span
    if (ch === '`') {
      const code = scanCodespan(src, i);
      if (code) {
        out += plain ? code.text : '<code>' + escapeHtmlEntities(code.text, true) + '</code>';
        i = code.end;
        continue;
      }
    }

    // hard break
    if (ch === ' ' || ch === '\\') {
      const brEnd = scanBr(src, i);
      if (brEnd !== -1) {
        if (!plain) out += '<br>';
        i = brEnd;
        continue;
      }
    }

    // strikethrough
    if (ch === '~') {
      const del = tryDel(src, i, getMasked(), getLastClosers(), prevChar);
      if (del) {
        const inner = renderInline(del.inner, links, state, plain);
        out += plain ? inner : '<del>' + inner + '</del>';
        i = del.end;
        continue;
      }
    }

    // extended autolink (only outside links); a url can start with an
    // alphanumeric or . _ + - (the email local part's first characters)
    if (!state.inLink && (isAlnum(ch) || ch === '.' || ch === '_' || ch === '+' || ch === '-')) {
      const url = scanUrl(src, i);
      if (url) {
        out += renderAutolink(url, plain);
        i = url.end;
        continue;
      }
    }

    // text run
    const end = scanTextRun(src, i);
    const run = src.slice(i, end);
    if (state.inRawBlock) {
      out += run;
    } else if (plain) {
      out += decodeNumericCharacterReferences(run);
    } else {
      out += escapeHtmlEntities(decodeNumericCharacterReferences(run));
    }
    if (run.charAt(run.length - 1) !== '_') prevChar = run.charAt(run.length - 1);
    keepPrevChar = true;
    i = end;
  }
  return out;
}
