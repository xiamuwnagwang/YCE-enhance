/**
 * Shared lexical layer for the local retrieval path.
 *
 * The prerank scorer (lib/directory-scorer.mjs) and the offline fallback
 * searcher (scripts/lib/localFastSearch.js) both stem and split identifiers,
 * and they used to carry separate copies that had drifted apart. The prerank
 * copy applied only the *first* matching stem rule, so `functions` stopped at
 * `function` while `function` went to `func` and the two never met, and it did
 * not split camelCase at all, so `screenCandidates` stayed a single token no
 * query could reach. This module is the one implementation of all three pieces.
 *
 * It is CommonJS on purpose: the fallback searcher is CJS and must be able to
 * `require` it, while the engine is an ESM package that can `import` it. Keeping
 * it under vendor/yce-engine/lib/ keeps the vendored engine self-contained —
 * the engine never reaches out into scripts/, only the other way around.
 */

// Chained rather than first-match: every suffix rule that still applies is
// applied in turn, so inflected forms collapse toward the same stem instead of
// stopping at whichever rule happened to be listed first.
function stem(word) {
  if (!word || word.length < 3) return word;
  return String(word)
    .toLowerCase()
    .replace(/^(.+)(ies)$/, "$1y")
    .replace(/^(.+)([^aeiou])(es)$/, "$1$2")
    .replace(/^(.+)([^aeiou])(s)$/, "$1$2")
    .replace(/^(.+)(ing|edly|ally|ation|tion|ment|ness|ful|less|able|ible|ive|ity|ly|ed)$/, "$1");
}

function splitCamelCase(text) {
  return String(text || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

const CJK_ONLY = /^[\u4e00-\u9fa5]+$/;
const NO_STOP_WORDS = new Set();

function isCjkToken(token) {
  return CJK_ONLY.test(String(token || ""));
}

/**
 * Character classes differ between the two consumers, so each one picks a
 * profile instead of the profiles being merged into one permissive default.
 */

// Routing is decided by scoreFiles' semanticGap/lowConfidence flags, not by an
// empty token list. Keeping CJK here lets BM25, structure and probe signals rank
// Chinese comments and UI strings before the semantic screen runs.
const PRERANK_CJK_ENABLED = String(process.env.YCE_PRERANK_CJK || "").trim() !== "0";

const PRERANK_PROFILE = PRERANK_CJK_ENABLED
  ? {
      strip: /[^\w\s\-./\\@\u4e00-\u9fa5]/g,
      split: /[\s\-./\\]+/,
      cjkBigrams: true,
      cjkBoundarySplit: true,
      unique: false,
    }
  : {
      strip: /[^\w\s\-./\\@]/g,
      split: /[\s\-./\\]+/,
      cjkBigrams: false,
      unique: false,
    };

// Used by the offline fallback searcher, which has no semantic screen behind it
// and so does its own CJK bigram splitting. It also treats `@ $ :` as
// separators, where the prerank profile keeps `@` inside a token.
const FALLBACK_PROFILE = {
  strip: /[^\w\s\-./@$:\u4e00-\u9fa5]/g,
  split: /[\s\-./\\@$:]+/,
  cjkBigrams: true,
  unique: true,
};

// The disabled arm keeps W4's numeric version so a pre-W5 index remains valid.
const TOKENIZER_VERSION = PRERANK_CJK_ENABLED ? "v2-cjk" : 1;

function tokenize(text, options = {}) {
  if (!text) return [];
  const {
    profile = PRERANK_PROFILE,
    stopWords = NO_STOP_WORDS,
    minLen = 2,
  } = options;

  let normalized = splitCamelCase(text).toLowerCase().replace(profile.strip, " ");
  if (profile.cjkBoundarySplit) {
    normalized = normalized
      .replace(/([\u4e00-\u9fa5])([^\u4e00-\u9fa5\s])/g, "$1 $2")
      .replace(/([^\u4e00-\u9fa5\s])([\u4e00-\u9fa5])/g, "$1 $2");
  }
  const raw = normalized.split(profile.split).filter(Boolean);

  const out = [];
  for (const token of raw) {
    if (profile.cjkBigrams && CJK_ONLY.test(token)) {
      for (let index = 0; index < token.length - 1; index += 1) {
        const pair = token.slice(index, index + 2);
        if (!stopWords.has(pair)) out.push(pair);
      }
      if (token.length > 2 && !stopWords.has(token)) out.push(token);
      continue;
    }
    if (token.length < minLen || stopWords.has(token)) continue;
    out.push(stem(token));
  }
  return profile.unique ? [...new Set(out)] : out;
}

/**
 * Bind a profile and stopword set once so call sites keep reading
 * `tokenize(text)`.
 */
function createTokenizer({ profile, stopWords, minLen = 2 }) {
  return (text, options = {}) => tokenize(text, {
    profile,
    stopWords,
    minLen: options.minLen === undefined ? minLen : options.minLen,
  });
}

module.exports = {
  stem,
  splitCamelCase,
  tokenize,
  createTokenizer,
  isCjkToken,
  PRERANK_PROFILE,
  FALLBACK_PROFILE,
  TOKENIZER_VERSION,
};
