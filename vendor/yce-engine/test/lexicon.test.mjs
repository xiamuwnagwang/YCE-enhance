import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  stem,
  splitCamelCase,
  tokenize as lexTokenize,
  PRERANK_PROFILE,
  FALLBACK_PROFILE,
} from "../lib/lexicon.cjs";
import { tokenize } from "../lib/directory-scorer.mjs";

const require = createRequire(import.meta.url);

test("the stemmer chains its rules instead of stopping at the first match", () => {
  // The prerank copy used to return on the first matching rule, so `functions`
  // stopped at `function` while `function` went on to `func` and the two forms
  // could never match each other.
  assert.equal(stem("functions"), "func");
  assert.equal(stem("function"), "func");
  assert.equal(stem("registrations"), "registra");
  assert.equal(stem("registration"), "registra");
  assert.equal(stem("ab"), "ab", "words shorter than 3 characters are left alone");
});

test("camelCase and consecutive capitals split into separate tokens", () => {
  assert.equal(splitCamelCase("screenCandidates"), "screen Candidates");
  assert.equal(splitCamelCase("XMLHttpRequest"), "XML Http Request");
  assert.deepEqual(tokenize("screenCandidates"), ["screen", "candidat"]);
  assert.deepEqual(tokenize("parseHTTPResponse"), ["parse", "http", "response"]);
});

test("the prerank profile splits CJK into bigrams plus the whole run", () => {
  // Chinese routing still comes from scoreFiles' semanticGap/lowConfidence;
  // these tokens only improve the local lexical, structure and probe signals.
  assert.deepEqual(tokenize("缓存失效"), ["缓存", "存失", "失效", "缓存失效"]);
  assert.deepEqual(
    lexTokenize("缓存失效", { profile: PRERANK_PROFILE }),
    ["缓存", "存失", "失效", "缓存失效"],
  );
  assert.deepEqual(tokenize("失效"), ["失效"]);
  assert.deepEqual(tokenize("jev权益闸"), ["jev", "权益", "益闸", "权益闸"]);
  assert.deepEqual(tokenize("单"), []);
  assert.deepEqual(
    tokenize("缓存失效，清空快照。"),
    ["缓存", "存失", "失效", "缓存失效", "清空", "空快", "快照", "清空快照"],
  );
  assert.ok(lexTokenize("缓存失效", { profile: FALLBACK_PROFILE }).includes("缓存"));
});

test("the prerank scorer and the offline fallback searcher share one lexicon", (t) => {
  // The vendored engine ships without the skill around it, so skip rather than
  // fail when the fallback layer is not present.
  let fallback;
  try {
    fallback = require("../../../scripts/lib/localFastSearch.js");
  } catch {
    t.skip("scripts/lib/localFastSearch.js is not part of a standalone engine checkout");
    return;
  }
  const words = ["functions", "function", "retried", "retry", "registrations", "leases"];
  for (const word of words) {
    const viaPrerank = tokenize(word);
    const viaFallback = fallback.tokenize(word);
    assert.deepEqual(viaFallback, viaPrerank, `"${word}" must stem identically in both layers`);
  }
});

test("the profiles' separators and CJK bigrams are pinned to a golden vector", () => {
  // FALLBACK_PROFILE is the only place `@ $ :` are separators and the only
  // place CJK is split into bigrams. Both are load-bearing for the offline
  // searcher and neither is observable from the prerank side, so they are
  // pinned exactly rather than probed with `includes`: a drift in either
  // character class would otherwise pass every other test in this file.
  const fallback = (text) => lexTokenize(text, { profile: FALLBACK_PROFILE });

  assert.deepEqual(fallback("a@b$c:d 缓存失效"), ["缓存", "存失", "失效", "缓存失效"]);
  assert.deepEqual(
    fallback("screenCandidates@relay:v2 键池失效"),
    ["screen", "candidat", "relay", "v2", "键池", "池失", "失效", "键池失效"],
  );
  assert.deepEqual(
    fallback("user@example.com/path-to/file.mjs"),
    ["user", "example", "com", "path", "to", "file", "mj"],
  );

  // The prerank profile keeps `@` inside a token while sharing CJK bigrams.
  assert.deepEqual(
    lexTokenize("a@b$c:d 缓存失效", { profile: PRERANK_PROFILE }),
    ["a@b", "缓存", "存失", "失效", "缓存失效"],
  );
  assert.deepEqual(
    lexTokenize("screenCandidates@relay:v2 键池失效", { profile: PRERANK_PROFILE }),
    ["screen", "candidates@relay", "v2", "键池", "池失", "失效", "键池失效"],
  );
});

test("YCE_PRERANK_CJK=0 restores the pre-W5 prerank tokenizer", () => {
  const lexiconPath = fileURLToPath(new URL("../lib/lexicon.cjs", import.meta.url));
  const script = [
    "const { tokenize, PRERANK_PROFILE, TOKENIZER_VERSION } = require(process.argv[1]);",
    "console.log(JSON.stringify({ tokens: tokenize('缓存失效', { profile: PRERANK_PROFILE }), version: TOKENIZER_VERSION }));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script, lexiconPath], {
    env: { ...process.env, YCE_PRERANK_CJK: "0" },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { tokens: [], version: 1 });
});

test("stopwords and the minimum length still apply", () => {
  assert.deepEqual(tokenize("the of and"), []);
  assert.deepEqual(tokenize("a bc"), ["bc"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
});
