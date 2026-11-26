// @ts-check
'use strict';
/**
 * Read Claude Code's permission prompt off the agent's screen (the core's headless xterm).
 *
 * The result is a PermissionPrompt (packages/shared/protocol.js). The app answers it with
 * agents.approve { promptId, choice }, and the core presses a key only if the prompt on screen
 * at that moment still has the same fingerprint. So this parser is safety-critical:
 *   - options are classified by their WORDING, never by their position;
 *   - anything unusual (unknown header, a question that doesn't fit the header, gaps in the
 *     numbering, two "Yes" options, no "No", text below the options that isn't a footer…)
 *     returns null, and the app sends the user to the terminal instead.
 *
 * Pure: text in, object out. No I/O.
 */
const crypto = require('crypto');

/**
 * @typedef {'allow'|'allow_always'|'allow_other'|'deny'} OptionKind
 * @typedef {{key: string, label: string, kind: OptionKind}} PromptOption
 * @typedef {{id: string, tool: string, detail: string, question: string, options: PromptOption[]}} PermissionPrompt
 */

/**
 * Prompt headers Claude Code draws, the question each one asks, and where its detail is.
 * @type {Array<{re: RegExp, tool: string, question: RegExp, detail: 'command'|'path'|'url'|'call'}>}
 */
const HEADERS = [
  { re: /^Bash command$/i, tool: 'Bash', question: /^Do you want to proceed\?$/i, detail: 'command' },
  { re: /^Edit file$/i, tool: 'Edit', question: /^Do you want to make this edit to (.+)\?$/i, detail: 'path' },
  { re: /^(?:Create|Write|Overwrite) file$/i, tool: 'Write', question: /^Do you want to (?:create|write to|write|overwrite) (.+)\?$/i, detail: 'path' },
  { re: /^Edit notebook$/i, tool: 'NotebookEdit', question: /^Do you want to (?:make this edit to|edit) (.+)\?$/i, detail: 'path' },
  { re: /^Read file$/i, tool: 'Read', question: /^Do you want to proceed\?$/i, detail: 'path' },
  { re: /^Fetch$/i, tool: 'WebFetch', question: /^Do you want to allow Claude to fetch this content\?$/i, detail: 'url' },
  { re: /^Tool use$/i, tool: '', question: /^Do you want to proceed\?$/i, detail: 'call' },
];

const OPTION_RE = /^(?:[❯›>▶▸»]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
const CURSOR_RE = /^[❯›>▶▸»]\s*/;
const FOOTER_RE = /\besc\b|to cancel|to amend|to select|to navigate|to confirm/i;
/** How many lines above the question the header may be (diffs can be long). */
const MAX_REGION = 60;
/** Non-footer lines tolerated under the options (e.g. a custom status line). */
const MAX_TRAILING = 2;

/** A line without box side borders, gutters and surrounding spaces. @param {string} line */
function clean(line) {
  let s = String(line || '').replace(/\s+$/, '');
  s = s.replace(/^\s*[│┃║|]\s?/, '').replace(/\s*[│┃║]$/, '');
  return s.trim();
}

/** A horizontal rule (or a box's top/bottom edge). @param {string} s cleaned line */
function isRule(s) {
  return s.length >= 3 && /^[─-╿\s]+$/.test(s) && (s.match(/[─-╿]/g) || []).length >= 3;
}

/** @param {string} s cleaned line */
function optionOf(s) {
  const m = OPTION_RE.exec(s);
  return m ? { n: Number(m[1]), label: m[2].trim() } : null;
}

/**
 * How Claude's wording reads: "Yes" → allow, "Yes, and don't ask again …" → allow_always, "No…" → deny.
 * @param {string} label @returns {OptionKind}
 */
function classify(label) {
  let s = String(label).toLowerCase().replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ').trim();
  s = s.split(' · ')[0].trim();
  for (let i = 0; i < 3; i++) s = s.replace(/\s*\([^()]*\)\s*$/, '').trim();
  s = s.replace(/[.!]+$/, '').trim();
  if (s === 'yes') return 'allow';
  if (/^no(?:$|[ ,;:])/.test(s)) return 'deny';
  if (/^yes,? (?:and )?(?:don't|do not) ask again\b/.test(s)) return 'allow_always';
  if (/^yes,? (?:and )?always allow\b/.test(s)) return 'allow_always';
  if (/^yes,? (?:and )?allow all\b/.test(s)) return 'allow_always';
  return 'allow_other';
}

/** @param {string} s */
const looksLikePath = (s) => /^[^\s]+$/.test(s) || /[\\/]/.test(s);

/**
 * The detail (command, file, URL, call) from the lines between the header and the question.
 * @param {'command'|'path'|'url'|'call'} kind @param {string[]} body cleaned lines @param {RegExpExecArray} q
 * @returns {{tool?: string, detail: string}|null}
 */
function detailOf(kind, body, q) {
  const rules = body.map((s, i) => (isRule(s) ? i : -1)).filter((i) => i >= 0);
  const beforeRule = body.slice(0, rules.length ? rules[0] : body.length).filter((s) => s && !/^Tip:/i.test(s));
  if (kind === 'command') {
    let lines;
    if (rules.length >= 2) lines = body.slice(rules[0] + 1, rules[1]).filter(Boolean);
    else if (rules.length === 1) lines = body.slice(rules[0] + 1).filter(Boolean).slice(0, 1);
    else lines = body.filter((s) => s && !/^Tip:/i.test(s)).slice(0, 1);
    const detail = lines.join(' ').trim();
    return detail ? { detail } : null;
  }
  if (kind === 'path') {
    const fromQuestion = (q[1] || '').trim();
    const line = beforeRule.find((s) => looksLikePath(s) && (!fromQuestion || s.endsWith(fromQuestion)));
    const detail = line || fromQuestion;
    return detail ? { detail } : null;
  }
  if (kind === 'url') {
    const url = beforeRule.find((s) => /^https?:\/\/\S+$/i.test(s));
    if (url) return { detail: url };
    const m = beforeRule.map((s) => /fetch content from (\S+)/i.exec(s)).find(Boolean);
    return m ? { detail: m[1] } : null;
  }
  // 'call': "server - tool(args) (MCP)" or "Tool(args)", possibly wrapped over a few lines.
  const para = [];
  for (const s of body) {
    if (!s || isRule(s)) { if (para.length) break; continue; }
    para.push(s);
  }
  const text = para.join(' ');
  const mcp = /^(.+?) - ([\w.-]+)\((.*)\)\s*\(MCP\)/.exec(text);
  if (mcp) {
    const server = mcp[1].trim().replace(/\s+/g, '_');
    return { tool: `mcp__${server}__${mcp[2]}`, detail: mcp[3].trim() || mcp[2] };
  }
  const plain = /^([A-Za-z][\w-]*)\((.*)\)/.exec(text);
  if (plain) return { tool: plain[1], detail: plain[2].trim() || plain[1] };
  return null;
}

/**
 * Parse the permission prompt at the bottom of the screen.
 * @param {string} screen   the visible screen text, lines separated by "\n"
 * @param {{salt?: string}} [opts]  salt: mixed into the fingerprint (the core passes agent id + when the
 *   PermissionRequest arrived, so an identical prompt asked again, or by another agent, gets another id)
 * @returns {PermissionPrompt|null}
 */
function parsePrompt(screen, opts = {}) {
  if (typeof screen !== 'string' || !screen) return null;
  const lines = screen.split(/\r?\n/).map(clean);

  // 1. The last option line, with only footer lines (and at most a couple of others) below it.
  let last = -1;
  let trailing = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i];
    if (!s || isRule(s)) continue;
    if (optionOf(s)) { last = i; break; }
    if (FOOTER_RE.test(s)) continue;
    if (/^Do you want\b/i.test(s) || CURSOR_RE.test(s)) return null; // a question or an input line under the options
    if (++trailing > MAX_TRAILING) return null;
  }
  if (last < 0) return null;

  // 2. Walk up through the options; non-option lines between two options continue the label above.
  /** @type {Array<{n: number, label: string, line: number}>} */
  const found = [];
  /** @type {string[]} */
  let pending = [];
  let first = last;
  for (let i = last; i >= 0 && i > last - 40; i--) {
    const s = lines[i];
    if (!s) break;
    const o = optionOf(s);
    if (o) {
      if (pending.length > 2) return null;
      found.unshift({ n: o.n, label: [o.label, ...pending].join(' '), line: i });
      pending = [];
      first = i;
    } else {
      if (/^Do you want\b/i.test(s)) break; // the question: the options start below it
      pending.unshift(s);
    }
  }
  const n = found.length;
  if (n < 2 || n > 9) return null;
  if (found.some((o, i) => o.n !== i + 1)) return null;

  // 3. The question right above the options (it may have wrapped onto two lines).
  let qi = first - 1;
  while (qi >= 0 && !lines[qi] && first - qi <= 2) qi--;
  if (qi < 0 || !lines[qi]) return null;
  let question = lines[qi];
  let qStart = qi;
  if (!/^Do you want\b/i.test(question) && qi > 0 && lines[qi - 1] && /^Do you want\b/i.test(lines[qi - 1])) {
    question = `${lines[qi - 1]} ${question}`;
    qStart = qi - 1;
  }
  if (!/^Do you want\b.*\?$/i.test(question)) return null;

  // 4. The header above it, which must fit the question.
  let hi = -1;
  /** @type {typeof HEADERS[number]|undefined} */
  let header;
  for (let i = qStart - 1; i >= 0 && i >= qStart - MAX_REGION; i--) {
    const s = lines[i];
    if (!s) continue;
    if (/^Do you want\b/i.test(s)) return null;
    header = HEADERS.find((x) => x.re.test(s));
    if (header) { hi = i; break; }
  }
  if (!header || hi < 0) return null;
  const q = header.question.exec(question);
  if (!q) return null;

  // 5. Tool and detail.
  const d = detailOf(header.detail, lines.slice(hi + 1, qStart), q);
  if (!d) return null;
  const tool = d.tool || header.tool;
  if (!tool) return null;

  // 6. Options, classified by wording. Exactly one plain "Yes", at most one "don't ask again", a "No".
  /** @type {PromptOption[]} */
  const options = found.map((o) => ({ key: String(o.n), label: o.label, kind: classify(o.label) }));
  const count = (/** @type {OptionKind} */ k) => options.filter((o) => o.kind === k).length;
  if (count('allow') !== 1 || count('allow_always') > 1 || count('deny') < 1) return null;

  // 7. Fingerprint of the prompt region as drawn (cursor position, borders and blank lines aside).
  const region = [];
  for (let i = hi; i <= last; i++) {
    const s = lines[i];
    if (!s) continue;
    region.push(optionOf(s) ? s.replace(CURSOR_RE, '') : s);
  }
  const hash = crypto.createHash('sha256').update(`${opts.salt || ''}\n${region.join('\n')}`).digest('hex');
  return { id: `p-${hash.slice(0, 24)}`, tool, detail: d.detail.slice(0, 2000), question, options };
}

module.exports = { parsePrompt, classify, clean, isRule, HEADERS };
