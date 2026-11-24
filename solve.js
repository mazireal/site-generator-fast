// A fast, dependency-free drop-in for makefun-site 1.0.0.
//
// Written from the semantics stated in makefun-site's README and its code
// (front matter, template dialect, Markdown subset, slug rule, report),
// re-implemented here in my own structure: one shared line split per source,
// a single-pass Markdown renderer with chunked inline scanning, cached
// slugs and dates, and templates parsed once per case.
//
// Exports run(input): the output tree (path -> file text) for one case.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const ESC_RE = /[&<>"']/;
const ESC_RE_G = /[&<>"']/g;

/** HTML-escape `s`, scanning once and copying only around escapes. */
function esc(s) {
  return ESC_RE.test(s) ? s.replace(ESC_RE_G, (c) => ESCAPES[c]) : s;
}

const NON_ASCII = /[^\x00-\x7F]/;

/** The slug of `text`: NFKD, combining marks dropped, runs of other chars one `-`. */
function slugifyRaw(text) {
  // ASCII text needs no normalisation: NFKD and mark-stripping are identities on it.
  let s = NON_ASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  s = s.replace(/[^a-zA-Z0-9]+/g, '-');
  if (s.charCodeAt(0) === 45) s = s.slice(1);
  s = s.slice(0, 64);
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 45) end--;
  if (end !== s.length) s = s.slice(0, end);
  s = s.toLowerCase();
  return s === '' ? 'untitled' : s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateRaw(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether a code unit is JavaScript whitespace (`\s`), as a lookup table. */
const WS = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS[c] = 1;
for (let c = 8192; c <= 8202; c++) WS[c] = 1;

const SLOW_PATH_RE = /(^|\/)\.{1,2}(\/|$)|(\/\/)|(^\/)|(\/$)/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` resolved from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  // Fast path: no '..', '.', or empty segment — a plain join.
  if (!SLOW_PATH_RE.test(rel)) return dir === '' ? rel : `${dir}/${rel}`;
  // Slow path, walked by hand over one string: no split arrays, no join.
  let res = dir;
  let i = 0;
  const n = rel.length;
  while (i < n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    const seg = rel.slice(i, j);
    if (seg === '..') {
      if (res === '') return null;
      const cut = res.lastIndexOf('/');
      res = cut === -1 ? '' : res.slice(0, cut);
    } else if (seg !== '' && seg !== '.') res = res === '' ? seg : `${res}/${seg}`;
    i = j + 1;
  }
  return res;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const KEY_RE = /^[a-z_]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A quoted or bare string value, or why it is refused. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter over its `lines`: { data, bodyStart } (the first
 * body line's index), or { error } with the first reason it is refused.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line[0] === '#') continue;
    const ci = line.indexOf(':');
    if (ci <= 0) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, ci);
    if (!KEY_RE.test(key)) return { error: `line ${i + 1} is not "key: value"` };
    const rest = line.slice(ci + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest[0] === ' ') raw = rest.slice(1);
    else return { error: `line ${i + 1} is not "key: value"` };
    // The value's trailing spaces and tabs, dropped without a regex.
    let end = raw.length;
    while (end > 0) {
      const c = raw.charCodeAt(end - 1);
      if (c !== 32 && c !== 9) break;
      end--;
    }
    if (end !== raw.length) raw = raw.slice(0, end);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- Markdown

const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

/** A fence-opening line's language, or null when it is not one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  let j = h;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j === h) return null;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: h, text: line.slice(j, end) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered item's start number and text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line[j] !== '.' || line[j + 1] !== ' ') return null;
  return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !/\s/.test(line[j]);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function paraEnds(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** A list starting at `lines[i]` (`firstText` its first item's text, `firstStart` its first number) rendered, with the next line index. */
function renderList(lines, i, n, isOrdered, firstText, firstStart, env, addWords) {
  const items = [[trimLine(firstText)]];
  i++;
  while (i < n) {
    const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
    if (m !== null) {
      addWords(lines[i]);
      items.push([trimLine(isOrdered ? m.text : m)]);
      i++;
    } else if (isContinued(lines[i])) {
      addWords(lines[i]);
      items[items.length - 1].push(trimLine(lines[i]));
      i++;
    } else break;
  }
  const tag = isOrdered ? 'ol' : 'ul';
  const open = isOrdered && firstStart !== 1 ? `<ol start="${firstStart}">` : `<${tag}>`;
  return [`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>\n`, i];
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * A run of backslashes before the match escapes it exactly when the run is odd:
 * the scanner pairs backslashes left to right, so an odd run leaves one to
 * escape the match's first character. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s[k] === '\\') {
      n++;
      k--;
    }
    if (n % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let n = 0;
    while (k >= from && s[k] === '\\') {
      n++;
      k--;
    }
    if (n % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds a character inline rendering handles. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/;

/** `s` rendered inline, or itself when it holds no character inline handles. */
function inlinePlain(s, env) {
  return INLINE_SPECIAL.test(s) ? inline(s, env) : s;
}

/** `s` rendered inline; `env.link(target)` resolves a link's href. A regex
 * jumps between the characters that need handling, so plain runs are copied
 * whole instead of scanned character by character. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const re = /[\\`*\[&<>"']/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (j > i) out += s.slice(i, j);
    if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        // The escaped character is itself HTML-escaped: of the escapable
        // characters only '>' changes under escaping.
        out += s[j + 1] === '>' ? '&gt;' : s[j + 1];
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      re.lastIndex = i;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${esc(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      re.lastIndex = i;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inlinePlain(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += `<em>${inlinePlain(s.slice(j + 1, k), env)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
      re.lastIndex = i;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const p = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = p === -1 ? '' : s.slice(k + 2, p);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${esc(env.link(target))}">${inlinePlain(s.slice(j + 1, k), env)}</a>`;
        i = p + 1;
      } else {
        out += '[';
        i = j + 1;
      }
      re.lastIndex = i;
      continue;
    }
    out += ESCAPES[c];
    i = j + 1;
  }
  if (i < s.length) out += s.slice(i);
  return out;
}

/**
 * `lines` from `start` rendered: its HTML, its table of contents (level 2
 * and 3 headings), its excerpt (the first paragraph's inline HTML) and its
 * word count (the body's words, runs of characters other than whitespace).
 * Every body line is consumed exactly once below, so the words are counted
 * as the lines are consumed instead of in a separate pass.
 */
function renderMarkdown(lines, start, env, slugOf) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  const addWords = (line) => {
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      if (WS[line.charCodeAt(j)]) inWord = false;
      else if (!inWord) {
        inWord = true;
        words++;
      }
    }
  };
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    addWords(line);
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // A line opening on a space or tab is blank or paragraph text.
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const fence = fenceOpen(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !fenceClose(lines[i])) {
          addWords(lines[i]);
          body.push(lines[i++]);
        }
        if (i < n) addWords(lines[i]);
        i++;
        const cls = fence === '' ? '' : ` class="language-${esc(fence)}"`;
        out.push(`<pre><code${cls}>`);
        if (body.length !== 0) out.push(esc(body.join('\n')), '\n');
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugOf(hd.text), ids);
        const html = inline(hd.text, env);
        out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const bullet = bulletOf(line);
      if (bullet !== null) {
        const r = renderList(lines, i, n, false, bullet, 1, env, addWords);
        out.push(r[0]);
        i = r[1];
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      let first = true;
      while (i < n) {
        const l = lines[i];
        if (l[0] !== '>') break;
        if (!first) addWords(l);
        first = false;
        body.push(l[1] === ' ' ? l.slice(2) : l.slice(1));
        i++;
      }      const inner = body.map(trimLine).filter((l) => l !== '');
      out.push(inner.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(inner.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const r = renderList(lines, i, n, true, ordered.text, ordered.start, env, addWords);
        out.push(r[0]);
        i = r[1];
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !paraEnds(lines[i])) {
      addWords(lines[i]);
      body.push(trimLine(lines[i++]));
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` holds only spaces or tabs from `a` to `b`. */
function onlySpaces(s, a, b) {
  for (let k = a; k < b; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag takes its line. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in its own digits, true/false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The first name of a path, read from the nearest loop scope holding it
 * (`S`, innermost last), else from the page's values (`R`).
 */
function lk(S, R, name) {
  for (let k = S.length - 1; k >= 0; k--) {
    if (Object.hasOwn(S[k], name)) return S[k][name];
  }
  return Object.hasOwn(R, name) ? R[name] : undefined;
}

/**
 * For each parsed template: whether its output depends only on the case's
 * constant values (`site`, `tags`, `recent`) — so one render per case serves
 * every page that includes it. A template is constant when every path in its
 * inlined tree, read with an empty scope stack, names a constant root or a
 * name its own `for`s bind. It also needs no `for` anywhere in the case to
 * bind a constant root (a loop over `site` would shadow it in a caller), and
 * a template whose includes cycle is never constant. The check is
 * conservative: a template it calls constant really is one.
 */
const CONST_ROOTS = new Set(['site', 'tags', 'recent']);
function analyzeTemplates(parsed) {
  const boundAnywhere = new Set();
  for (const nodes of parsed.values()) {
    const walk = (ns) => {
      for (const node of ns) {
        if (node.kind === 'for') {
          boundAnywhere.add(node.name);
          walk(node.body);
        } else if (node.kind === 'if') {
          walk(node.then);
          if (node.else !== null) walk(node.else);
        }
      }
    };
    walk(nodes);
  }
  const rootsFree = [...CONST_ROOTS].every((r) => !boundAnywhere.has(r));
  const info = new Map();
  for (const [name, nodes] of parsed) {
    let constant = rootsFree;
    const stack = [];
    const seen = new Set([name]);
    const ok = (path) => CONST_ROOTS.has(path[0]) || stack.includes(path[0]);
    const walk = (ns) => {
      for (const node of ns) {
        if (node.kind === 'for') {
          if (!ok(node.path)) constant = false;
          stack.push(node.name, 'loop');
          walk(node.body);
          stack.pop();
          stack.pop();
        } else if (node.kind === 'if') {
          if (!ok(node.path)) constant = false;
          walk(node.then);
          if (node.else !== null) walk(node.else);
        } else if (node.kind === 'var' || node.kind === 'raw') {
          if (!ok(node.path)) constant = false;
        } else if (node.kind === 'include') {
          const target = parsed.get(node.name);
          if (target === undefined) continue;
          if (seen.has(node.name)) {
            constant = false;
            continue;
          }
          seen.add(node.name);
          walk(target);
          seen.delete(node.name);
        }
      }
    };
    walk(nodes);
    info.set(name, constant);
  }
  return info;
}

/**
 * A parsed template's nodes compiled into a render function
 * `fn(R, S, T, D, lk, textOf, truthy, esc, C)`: `R` the page's values, `S` the
 * loop scopes (innermost last), `T` the compiled templates by name, `D` the
 * include depth, `C` the case's pre-rendered constant templates by name.
 * Compiling once per case replaces walking the node tree on every page; the
 * generated code keeps the tree's exact semantics (own properties only,
 * `loop` before the loop's element, includes at most 8 deep).
 *
 * Includes are inlined into the caller, so a page render is one function
 * call instead of one per partial, and paths hoisted once per render are
 * shared across the inlined tree. An include of a template already being
 * inlined (a cycle) falls back to a runtime call at the current depth, which
 * keeps the depth limit exact; a missing include renders nothing, as before.
 * A `for` reuses one scope object and one `loop` object per execution of the
 * statement, mutated per element: the objects are function locals, so a
 * re-entrant render gets its own, and a template cannot keep a reference to
 * one past its iteration (it can only read it while rendering).
 * An include of a constant template is not inlined: it reads the template's
 * pre-rendered text from `C` when the include is at depth 0 — the depth a
 * layout's includes run at, and the depth the pre-render ran at, so the
 * depth limit decides the same inside it — and otherwise renders it fresh.
 */
function compileTemplate(name, nodes, allNodes, constant) {
  let n = 0;
  const next = () => `_v${n++}`;
  // Names a `for` in this template's inlined tree binds, and every path it
  // uses. A path whose first name no `for` in the tree binds resolves the
  // same everywhere in one render (the page's values never change, and the
  // loop scopes only gain frames from this tree's own `for`s), so it is
  // computed once up front.
  const bound = new Set();
  const paths = new Map();
  const seen = new Set([name]);
  const collect = (ns) => {
    for (const node of ns) {
      if (node.kind === 'for') {
        bound.add(node.name);
        bound.add('loop');
        paths.set(node.path.join('.'), node.path);
        collect(node.body);
      } else if (node.kind === 'if') {
        paths.set(node.path.join('.'), node.path);
        collect(node.then);
        if (node.else !== null) collect(node.else);
      } else if (node.kind === 'var' || node.kind === 'raw') paths.set(node.path.join('.'), node.path);
      else if (node.kind === 'include') {
        // A constant include is read from C at render time, not executed
        // here, so its paths and bindings are not this function's.
        if (constant.get(node.name) === true) continue;
        const target = allNodes.get(node.name);
        if (target !== undefined && !seen.has(node.name)) {
          seen.add(node.name);
          collect(target);
        }
      }
    }
  };
  collect(nodes);
  const hoisted = new Map();
  const lines = ['let o = "";'];
  for (const [key, path] of paths) {
    if (bound.has(path[0])) continue;
    const hv = `_h${hoisted.size}`;
    hoisted.set(key, hv);
    lines.push(`let ${hv} = lk(S, R, ${JSON.stringify(path[0])});`);
    for (let k = 1; k < path.length; k++) {
      const p = JSON.stringify(path[k]);
      lines.push(`${hv} = ${hv} !== null && typeof ${hv} === "object" && Object.hasOwn(${hv}, ${p}) ? ${hv}[${p}] : undefined;`);
    }
  }
  const emitLookup = (path) => {
    const hv = hoisted.get(path.join('.'));
    if (hv !== undefined) return hv;
    // A name this template's own `for`s bind resolves to the innermost such
    // scope. While this template's code runs, its own scopes are the topmost
    // entries of S (an include's scopes are pushed above and popped before
    // this code resumes), so the depth from the top is statically known and
    // the scope walk can be a single index. A bound name with no active
    // scope here falls through to lk, which keeps dynamic scoping. (`loop`
    // is bound by every `for`, so it is the innermost scope.)
    let idx = -1;
    if (path[0] === 'loop') idx = scopes.length - 1;
    else {
      for (let k = scopes.length - 1; k >= 0; k--) {
        if (scopes[k] === path[0]) {
          idx = k;
          break;
        }
      }
    }
    const t = next();
    if (idx !== -1) {
      lines.push(`let ${t} = S[S.length - 1 - ${scopes.length - 1 - idx}][${JSON.stringify(path[0])}];`);
    } else {
      lines.push(`let ${t} = lk(S, R, ${JSON.stringify(path[0])});`);
    }
    for (let k = 1; k < path.length; k++) {
      const p = JSON.stringify(path[k]);
      lines.push(`${t} = ${t} !== null && typeof ${t} === "object" && Object.hasOwn(${t}, ${p}) ? ${t}[${p}] : undefined;`);
    }
    return t;
  };
  // The variable names the active `for` scopes bind, innermost last (one
  // entry per scope object; each scope also holds `loop`).
  const scopes = [];
  // The templates being inlined into this function, innermost last: an
  // include of one of these is a cycle and goes through a runtime call.
  const inlineStack = [name];
  const emitNodes = (ns) => {
    for (const node of ns) emit(node);
  };
  const emit = (node) => {
    switch (node.kind) {
      case 'text':
        lines.push(`o += ${JSON.stringify(node.text)};`);
        break;
      case 'var': {
        const t = emitLookup(node.path);
        lines.push(`o += esc(textOf(${t}));`);
        break;
      }
      case 'raw': {
        const t = emitLookup(node.path);
        lines.push(`o += textOf(${t});`);
        break;
      }
      case 'if': {
        const t = emitLookup(node.path);
        lines.push(`if (truthy(${t}) === ${String(!node.not)}) {`);
        emitNodes(node.then);
        if (node.else !== null) {
          lines.push('} else {');
          emitNodes(node.else);
        }
        lines.push('}');
        break;
      }
      case 'for': {
        const t = emitLookup(node.path);
        const xs = next();
        const k = next();
        const sc = next();
        const lp = next();
        lines.push(`{ const ${xs} = ${t}; if (Array.isArray(${xs})) { const ${sc} = { [${JSON.stringify(node.name)}]: undefined, loop: null }; const ${lp} = { index: 0, first: false, last: false, length: ${xs}.length }; ${sc}.loop = ${lp}; for (let ${k} = 0; ${k} < ${xs}.length; ${k}++) { ${lp}.index = ${k} + 1; ${lp}.first = ${k} === 0; ${lp}.last = ${k} === ${xs}.length - 1; ${sc}[${JSON.stringify(node.name)}] = ${xs}[${k}]; S.push(${sc});`);
        scopes.push(node.name);
        emitNodes(node.body);
        scopes.pop();
        lines.push(`S.pop(); } } }`);
        break;
      }
      case 'include': {
        const target = allNodes.get(node.name);
        if (target === undefined) break; // a missing include renders nothing
        if (constant.get(node.name) === true) {
          // Read the template's pre-rendered text when this include runs at
          // depth 0 (the depth a layout's includes run at, and the depth the
          // pre-render ran at, so the depth limit decides the same inside
          // it); otherwise render it fresh at the current depth.
          lines.push(`{ if (D === 0) { const _c = C.get(${JSON.stringify(node.name)}); if (_c !== undefined) o += _c; else { const _f = T.get(${JSON.stringify(node.name)}); if (_f !== undefined) o += _f(R, S, T, 1, lk, textOf, truthy, esc, C); } } else if (D < 8) { const _f = T.get(${JSON.stringify(node.name)}); if (_f !== undefined) o += _f(R, S, T, D + 1, lk, textOf, truthy, esc, C); } }`);
          break;
        }
        if (inlineStack.includes(node.name)) {
          lines.push(`{ const _f = T.get(${JSON.stringify(node.name)}); if (_f !== undefined && D < 8) o += _f(R, S, T, D + 1, lk, textOf, truthy, esc, C); }`);
          break;
        }
        lines.push(`if (D < 8) { D++;`);
        inlineStack.push(node.name);
        emitNodes(target);
        inlineStack.pop();
        lines.push(`D--; }`);
        break;
      }
    }
  };
  emitNodes(nodes);
  lines.push('return o;');
  return new Function('R', 'S', 'T', 'D', 'lk', 'textOf', 'truthy', 'esc', 'C', lines.join('\n'));
}

// ---------------------------------------------------------------- the build

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const slugOf = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugifyRaw(t);
      slugCache.set(t, s);
    }
    return s;
  };
  const longOf = (d) => {
    let s = dateCache.get(d);
    if (s === undefined) {
      s = longDateRaw(d);
      dateCache.set(d, s);
    }
    return s;
  };

  // Templates, parsed and compiled in code-unit order of name; one that does not parse is reported and left out.
  // Parsing comes first so compiling can inline the includes (see compileTemplate).
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const templates = new Map();
  const constant = analyzeTemplates(parsed);
  for (const [name, nodes] of parsed) templates.set(name, compileTemplate(name, nodes, parsed, constant));

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, sorted by path in code-unit order; line ends made "\n".
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, lines: (c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n')).split('\n') });
    } else statics.push(f);
  }

  // Front matter and the refusal checks, in order; a draft is reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug, unique in its directory in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  // One link resolver for the case: rendering is sequential, so the source it
  // resolves for is kept in two variables set before each source is rendered.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  let curDir = '';
  let curPath = '';
  const env = {
    link: (target) => {
      // A scheme needs a colon; most targets have none, so skip the regex then.
      if (target[0] === '/' || target[0] === '#' || (target.indexOf(':') !== -1 && SCHEME_RE.test(target))) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(curDir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${curPath} -> ${target}`);
      return target;
    },
  };
  for (const s of kept) {
    curDir = dirOf(s.path);
    curPath = s.path;
    const md = renderMarkdown(s.lines, s.bodyStart, env, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(md.words / 200));
  }

  // Collections: posts newest first, equal dates by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  // Each post's neighbour links, built once: a page's record reuses them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longOf(s.data.date) });
  for (const p of posts) {
    p.newerLink = linkOf(p.newer);
    p.olderLink = linkOf(p.older);
  }

  // Tags: grouped by slug, named as first met walking the posts in collection order.
  const bySlug = new Map();
  // A source's tag names, each slug once (the first spelling kept). A source
  // holds at most a few tags, so a linear scan beats a Set here.
  const ownTags = (s) => {
    const tags = s.data.tags ?? [];
    const out = [];
    const slugs = [];
    for (const name of tags) {
      const slug = slugOf(name);
      if (slugs.indexOf(slug) === -1) {
        slugs.push(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugOf(name)) ?? { name, slug: slugOf(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // One record per page serves both as its card and as its page: the card
  // fields and the page fields hold the same values, so a single object
  // replaces the two objects (and the cards map) the build used to make.
  for (const s of kept) {
    s.tagCards = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    s.rec = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longOf(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s.readingMinutes,
      tags: s.tagCards,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: s.post ? s.newerLink : null,
      older: s.post ? s.olderLink : null,
      is_post: s.post,
    };
  }

  // Layouts: every page through its layout, the index pages and the tag pages.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.rec);
  // One values object, reused for every render: the keys a render does not
  // use are left undefined, which reads exactly as absent.
  const R = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  // The constant templates, rendered once for the case at depth 1 (the depth
  // a layout's include of one runs at): every page reuses the same text.
  const constRenders = new Map();
  for (const [name, isConstant] of constant) {
    if (!isConstant) continue;
    const fn = templates.get(name);
    if (fn !== undefined) constRenders.set(name, fn(R, [], templates, 1, lk, textOf, truthy, esc, constRenders));
  }
  const render = (name) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn(R, [], templates, 0, lk, textOf, truthy, esc, constRenders);
  };
  const output = {};
  let pageCount = 0;
  for (const s of kept) {
    R.page = s.rec;
    R.posts = undefined;
    R.pager = undefined;
    R.tag = undefined;
    if (!s.post) pageCount++;
    output[`${s.outDir}/index.html`] = render(s.layout);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    R.page = undefined;
    R.posts = posts.slice((k - 1) * per, k * per).map((p) => p.rec);
    R.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    R.tag = undefined;
    const html = render('index');
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    R.page = undefined;
    R.posts = undefined;
    R.pager = undefined;
    R.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.rec) };
    const html = render('tag');
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  R.page = undefined;
  R.posts = undefined;
  R.pager = undefined;
  R.tag = undefined;
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
