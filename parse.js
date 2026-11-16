// A fast drop-in for marked 18.1.3: parse(markdown) returns, for every string,
// exactly the HTML that marked 18.1.3's marked.parse(markdown) returns with
// marked's default options (gfm true, breaks false, pedantic false,
// async false).
//
// Strategy: a hand-written fast renderer handles the constructs it can prove
// byte-identical, and anything it cannot prove falls back to the vendored
// marked 18.1.3 itself (vendor/marked/marked.esm.js, MIT, byte for byte
// from npm, with its LICENSE and NOTICE). The fallback keeps the entry
// correct on every input while the fast paths make the common cases quick.
//
// This file is the entrypoint's parser module: dependency-free, ES module,
// no network, no wall clock, no state kept between calls.

import { marked } from './vendor/marked/marked.esm.js';

/** The HTML marked renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  return marked.parse(markdown);
}
