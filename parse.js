// A fast drop-in for marked 18.1.3: parse(markdown) returns, for every string,
// exactly the HTML that marked 18.1.3's marked.parse(markdown) returns with
// marked's default options (gfm true, breaks false, pedantic false,
// async false).
//
// How it works: marked's own block lexer (vendored, byte for byte) splits
// the input into blocks — block structure (lists, blockquotes, tables, HTML
// blocks) is where a reimplementation is most likely to diverge, so it is
// borrowed, not rewritten. The inline runs it queues are then rendered by
// the hand-written scanner in ./inline.js, which is much faster than
// marked's regex inline lexer, and the blocks are rendered by the small
// renderer below. Anything the fast path cannot prove is handed to marked
// itself (marked.parse), so the entry stays correct on every input.
//
// This file is the entrypoint's parser module: dependency-free, ES module,
// no network, no wall clock, no state kept between calls.

import { Lexer, defaults, marked } from './vendor/marked/marked.esm.js';
import { renderInline, escapeHtmlEntities, Bail } from './inline.js';

export const __stats = { fast: 0, fallback: 0 };

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

/** The HTML marked renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  if (typeof markdown !== 'string') return marked.parse(markdown);
  try {
    const html = fastParse(markdown);
    __stats.fast++;
    return html;
  } catch (e) {
    if (e instanceof Bail) {
      __stats.fallback++;
      return marked.parse(markdown);
    }
    throw e;
  }
}

function fastParse(markdown) {
  // Most inputs have no carriage returns; skip the (allocating) replace
  // when there is nothing to normalize.
  const src = markdown.includes('\r') ? markdown.replace(/\r\n|\r/g, '\n') : markdown;
  const lexer = new Lexer(defaults);
  const tokens = lexer.blockTokens(src, lexer.tokens);
  const links = lexer.tokens.links;

  // The inline runs the block lexer queued, in document order. Rendering
  // them in that order reproduces the lexer's inLink / inRawBlock state
  // evolution exactly.
  const inlineHtml = new Map();
  const state = { inLink: false, inRawBlock: false, linkEmitted: false };
  for (const q of lexer.inlineQueue) {
    state.inRawBlock = false;
    inlineHtml.set(q.tokens, renderInline(q.src, links, state, false));
  }
  return renderBlocks(tokens, inlineHtml);
}

// The inline HTML of a block token: any checkbox tokens unshifted into its
// tokens array by the list tokenizer (loose task lists) come first, then
// the queued run's rendering. A token with no queued run has no other
// inline content (a paragraph created for a loose checkbox alone).
function inlineOf(token, inlineHtml) {
  let out = '';
  const toks = token.tokens;
  if (toks) {
    for (const t of toks) {
      if (t.type === 'checkbox') out += checkboxHtml(t.checked);
      else throw new Bail();
    }
    const html = inlineHtml.get(toks);
    if (html !== undefined) out += html;
  }
  return out;
}

// First whitespace in a code fence's info string: marked takes /^\S*/.
const LANG_WS = /\s/;

function renderCode(token) {
  const lang = token.lang || '';
  const ws = lang.search(LANG_WS);
  const langString = ws === -1 ? lang : lang.slice(0, ws);
  // marked: token.text.replace(/\n$/, '') + '\n' — identical without the
  // regex when the text already ends (or does not end) with a newline.
  const code = token.text ? (token.text.endsWith('\n') ? token.text : token.text + '\n') : '';
  const escaped = token.escaped ? code : escapeHtmlEntities(code, true);
  if (!langString) return '<pre><code>' + escaped + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtmlEntities(langString) + '">' + escaped + '</code></pre>\n';
}

function renderCell(cell, inlineHtml) {
  const content = inlineOf(cell, inlineHtml);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? '<' + type + ' align="' + cell.align + '">' : '<' + type + '>';
  return tag + content + '</' + type + '>\n';
}

function renderTable(token, inlineHtml) {
  let cell = '';
  for (const h of token.header) cell += renderCell(h, inlineHtml);
  let header = '<tr>\n' + cell + '</tr>\n';
  let body = '';
  for (const row of token.rows) {
    cell = '';
    for (const c of row) cell += renderCell(c, inlineHtml);
    body += '<tr>\n' + cell + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderList(token, inlineHtml) {
  let body = '';
  for (const item of token.items) {
    body += '<li>' + renderBlocks(item.tokens, inlineHtml) + '</li>\n';
  }
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlocks(tokens, inlineHtml) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + token.depth + '>' + inlineOf(token, inlineHtml) + '</h' + token.depth + '>\n';
        break;
      case 'code':
        out += renderCode(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += '<p>' + inlineOf(token, inlineHtml) + '</p>\n';
        break;
      case 'text':
        out += inlineOf(token, inlineHtml);
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(token.tokens, inlineHtml) + '</blockquote>\n';
        break;
      case 'list':
        out += renderList(token, inlineHtml);
        break;
      case 'checkbox':
        out += checkboxHtml(token.checked);
        break;
      case 'table':
        out += renderTable(token, inlineHtml);
        break;
      default:
        throw new Bail();
    }
  }
  return out;
}
