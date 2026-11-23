// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md: the command line,
// the output and exit codes, safe paths, format detection, three-tier line matching (section 5),
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits
// (section 9) and the all-or-nothing write (section 10). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines, with its own line break and whether it ends with one (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---- Section 5: matching lines ---- */

/** One line equal at a tier: 0 exact, 1 trailing spaces/tabs ignored, 2 both ends ignored. */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const trimEnd = (s: string): string => s.replace(/[ \t]+$/, '');
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return trimBoth(a) === trimBoth(b);
}

/** Every 0-based position where O occurs in F at a tier; occurrences may overlap. */
function occurrencesAt(O: string[], F: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(O[j]!, F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function findTier(O: string[], F: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrencesAt(O, F, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Map N's lines onto the file at match position `pos`: a context line (nCtx[j] >= 0, the index of
 * that line in O) is written as the file's own matched line; any other line is written as it is,
 * except at tier 2 where it is re-indented from O's first line's leading whitespace to the file's.
 */
function mapNewLines(F: string[], O: string[], N: string[], nCtx: number[], pos: number, tier: number): string[] {
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const Fws = pos < F.length ? leadingWs(F[pos]!) : '';
  return N.map((ln, j) => {
    const oi = nCtx[j]!;
    if (oi >= 0) return F[pos + oi]!;
    if (tier === 2) {
      if (ln === '' || /^[ \t]+$/.test(ln)) return ln;
      if (P === '') return Fws + ln;
      if (ln.startsWith(P)) return Fws + ln.slice(P.length);
      return ln;
    }
    return ln;
  });
}

/* ---- Section 9: JSON edits ---- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Section 6: unified diffs ---- */

interface Hunk {
  /** 1-based old start from the header. */
  a: number;
  /** Old lines: context and `-` lines, in body order. */
  o: string[];
  /** New lines: context and `+` lines, in body order. */
  n: string[];
  /** For each line of n: its index in o when it is a context line, else -1. */
  nCtx: number[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface UniSection {
  oldP: string | null;
  newP: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const t = line.slice(4).split('\t')[0]!;
  return t.trim();
}

/** Strip one leading `a/` or `b/` from a path; `/dev/null` becomes null (no file). */
function uniPath(raw: string): string | null {
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Parse one hunk body starting just after its header at `hi`; returns the hunk and the next index. */
function parseHunkBody(lines: string[], hi: number, a: number): { hunk: Hunk; next: number } {
  const body: string[] = [];
  let j = hi + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith(' ')) {
      const oi = o.length;
      o.push(l.slice(1));
      n.push(l.slice(1));
      nCtx.push(oi);
      lastCtxPlus = k;
    } else if (l === '') {
      const oi = o.length;
      o.push('');
      n.push('');
      nCtx.push(oi);
      lastCtxPlus = k;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push(l.slice(1));
      nCtx.push(-1);
      lastCtxPlus = k;
      lastPlus = k;
    }
  }
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  const plusNoEol = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { hunk: { a, o, n, nCtx, noEol, plusNoEol }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let pairSeen = false;
  const n = lines.length;
  const err = (ln: number): never => {
    throw new Exit2(`error: parse ${ln}`);
  };
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) err(i + 1);
      cur = { oldP: m[1]!, newP: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      pairSeen = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        const oldRaw = headerPath(l);
        const newRaw = headerPath(lines[i + 1]!);
        if (inHeader && cur !== null && !pairSeen) {
          cur.oldP = uniPath(oldRaw);
          cur.newP = uniPath(newRaw);
          pairSeen = true;
        } else {
          cur = { oldP: uniPath(oldRaw), newP: uniPath(newRaw), create: false, del: false, hunks: [] };
          sections.push(cur);
          inHeader = true;
          pairSeen = true;
        }
        i += 2;
        continue;
      }
      if (inHeader) err(i + 2);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) err(i + 1);
      if (cur === null) err(i + 1);
      const { hunk, next } = parseHunkBody(lines, i, Number(m[1]));
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) {
        if (!pairSeen) cur.oldP = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (!pairSeen) cur.newP = l.slice('rename to '.length).trim();
      } else if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.create = true;
      } else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.del = true;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniSectionEdit(s, strict));
}

/** Apply a section's hunks in order to a file's lines; `d` tracks the running line shift. */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let cur = f;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), cur.lines.length);
      const atEnd = pos === cur.lines.length;
      const nf = atEnd ? !h.noEol : cur.final;
      cur = { lines: [...cur.lines.slice(0, pos), ...h.n, ...cur.lines.slice(pos)], br: cur.br, final: nf };
    } else {
      const found = findTier(h.o, cur.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const mapped = mapNewLines(cur.lines, h.o, h.n, h.nCtx, best, found.tier);
      const atEnd = best + h.o.length === cur.lines.length;
      const nf = atEnd ? !h.noEol : cur.final;
      cur = { lines: [...cur.lines.slice(0, best), ...mapped, ...cur.lines.slice(best + h.o.length)], br: cur.br, final: nf };
    }
    d += h.n.length - h.o.length;
  }
  return cur;
}

function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldP;
    const newP = s.newP;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || s.create;
    const isDelete = !isCreate && (newP === null || s.del);
    if (isCreate) {
      if (newP === null) throw new Fail('missing', oldP ?? '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (let k = 0; k < h.n.length; k++) {
          if (h.nCtx[k] === -1) plus.push(h.n[k]!);
        }
      }
      let noEol = false;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        if (h.n.some((_, k) => h.nCtx[k] === -1)) {
          noEol = h.plusNoEol;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('missing', newP ?? '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = renderFile(applyHunks(parseFile(text), s.hunks, strict, oldP));
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = (oldP ?? newP)!;
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, renderFile(applyHunks(parseFile(text), s.hunks, strict, p)));
  };
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = parseFile(text);
    const found = findTier(oldLines, f.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const mapped = mapNewLines(f.lines, oldLines, newLines, newLines.map(() => -1), pos, found.tier);
    tree.now.set(
      path,
      renderFile({ lines: [...f.lines.slice(0, pos), ...mapped, ...f.lines.slice(pos + oldLines.length)], br: f.br, final: f.final }),
    );
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  nCtx: number[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundIdx = -1;
        const maxTier = strict ? 0 : 2;
        for (let t = 0; t <= maxTier && foundIdx < 0; t++) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (tierEq(ch.anchor, f.lines[k]!, t)) {
              foundIdx = k;
              break;
            }
          }
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        f = { lines: [...f.lines.slice(0, pos), ...ch.n, ...f.lines.slice(pos)], br: f.br, final: f.final };
        cursor = pos + ch.n.length;
      } else {
        let found: { tier: number; occ: number[] } | null = null;
        const maxTier = strict ? 0 : 2;
        for (let t = 0; t <= maxTier; t++) {
          const occ: number[] = [];
          for (let k = cursor; k + ch.o.length <= f.lines.length; k++) {
            let ok = true;
            for (let j = 0; j < ch.o.length; j++) {
              if (!tierEq(ch.o[j]!, f.lines[k + j]!, t)) {
                ok = false;
                break;
              }
            }
            if (ok) occ.push(k);
          }
          if (occ.length > 0) {
            found = { tier: t, occ };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        let pos = found.occ[0]!;
        if (ch.eof) {
          const endOcc = found.occ.filter((p) => p + ch.o.length === f.lines.length);
          if (endOcc.length === 0) throw new Fail('no-match', path);
          pos = endOcc[0]!;
        }
        const mapped = mapNewLines(f.lines, ch.o, ch.n, ch.nCtx, pos, found.tier);
        f = { lines: [...f.lines.slice(0, pos), ...mapped, ...f.lines.slice(pos + ch.o.length)], br: f.br, final: f.final };
        cursor = pos + mapped.length;
      }
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  const err = (ln: number): never => {
    throw new Exit2(`error: parse ${ln}`);
  };
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < end) {
    while (i < end && blank(lines[i]!)) i++;
    if (i >= end) break;
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const secLines: string[] = [];
      while (i < end) {
        const s = lines[i]!;
        if (isSectionStart(s)) break;
        if (s.startsWith('+')) {
          secLines.push(s.slice(1));
          i++;
        } else if (s === '') {
          secLines.push('');
          i++;
        } else err(i + 1);
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      edits.push(v4aAddEdit(path, secLines));
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      edits.push(v4aDeleteEdit(path));
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let firstChunk = true;
      while (i < end) {
        if (isSectionStart(lines[i]!)) break;
        if (lines[i]!.startsWith('@@') || (firstChunk && (lines[i]!.startsWith(' ') || lines[i]!.startsWith('-') || lines[i]!.startsWith('+') || lines[i]! === ''))) {
          let anchor: string | null = null;
          let eof = false;
          if (lines[i]!.startsWith('@@')) {
            const a = lines[i]!.slice(2).trim();
            anchor = a === '' ? null : a;
            i++;
          }
          const o: string[] = [];
          const n: string[] = [];
          const nCtx: number[] = [];
          while (i < end) {
            const s = lines[i]!;
            if (s.startsWith('@@') || s === '*** End of File' || isSectionStart(s)) break;
            if (s.startsWith(' ')) {
              const oi = o.length;
              o.push(s.slice(1));
              n.push(s.slice(1));
              nCtx.push(oi);
              i++;
            } else if (s.startsWith('-')) {
              o.push(s.slice(1));
              i++;
            } else if (s.startsWith('+')) {
              n.push(s.slice(1));
              nCtx.push(-1);
              i++;
            } else if (s === '') {
              const oi = o.length;
              o.push('');
              n.push('');
              nCtx.push(oi);
              i++;
            } else err(i + 1);
          }
          while (o.length > 0 && n.length > 0 && o[o.length - 1] === '' && n[n.length - 1] === '') {
            o.pop();
            n.pop();
            nCtx.pop();
          }
          if (i < end && lines[i] === '*** End of File') {
            eof = true;
            i++;
          }
          chunks.push({ anchor, eof, o, n, nCtx });
          firstChunk = false;
        } else if (blank(lines[i]!)) {
          i++;
        } else err(i + 1);
      }
      if (chunks.length === 0 && moveTo === null) err(updateLine);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    } else {
      err(i + 1);
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Section 1, 2 and 10: invocation, output, atomicity ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: Array<{ key: string; line: string }> = [];
  const moveDone = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.original(n) === null && tree.now.get(o) === null && tree.now.get(n) !== null) {
      changed.push({ key: n, line: `R ${o} -> ${n}` });
      moveDone.add(o);
      moveDone.add(n);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (moveDone.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
