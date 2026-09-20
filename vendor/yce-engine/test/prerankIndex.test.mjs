import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { scoreFiles } from "../lib/directory-scorer.mjs";
import { TOKENIZER_VERSION } from "../lib/lexicon.cjs";
import {
  PRERANK_INDEX_VERSION,
  __test as indexTest,
  prerankIndexPath,
} from "../lib/prerank-index.mjs";

const ENV_KEYS = [
  "YCE_PRERANK_INDEX",
  "YCE_PRERANK_INDEX_DIR",
  "YCE_PRERANK_INDEX_MAX_BYTES",
  "YCE_PRERANK_INDEX_MIN_DOCS",
];

function makeFixture(t, { files = 80 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-index-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  for (let index = 0; index < files; index += 1) {
    const comment = index % 4 === 0 ? "// lease pool scheduler\n" : "";
    writeFileSync(
      join(root, "src", `handler_${index}.js`),
      `${comment}export function handler${index}(pool) { return pool[0]; }\n`,
    );
  }
  writeFileSync(
    join(root, "src", "lease_scheduler.js"),
    "export function selectUpstreamKey(pool) { return pool[0]; } // lease pool scheduler\n",
  );
  writeFileSync(
    join(root, "src", "lease_scheduler.test.js"),
    "export function testLeaseScheduler(pool) { return pool[0]; } // lease pool scheduler\n",
  );
  writeFileSync(join(root, "src", "binary.bin"), "binary\u0000blob");
  writeFileSync(join(root, "src", "empty.js"), "");
  writeFileSync(join(root, "src", "huge.js"), "x".repeat(1024 * 1024 + 1));
  writeFileSync(join(root, "README.md"), "lease pool fixture\n");
  return root;
}

function useIndexEnv(t, overrides = {}, { defaultMinDocs = false } = {}) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const indexDir = mkdtempSync(join(tmpdir(), "yce-prerank-index-cache-"));
  process.env.YCE_PRERANK_INDEX_DIR = indexDir;
  delete process.env.YCE_PRERANK_INDEX;
  delete process.env.YCE_PRERANK_INDEX_MAX_BYTES;
  if (defaultMinDocs) delete process.env.YCE_PRERANK_INDEX_MIN_DOCS;
  else process.env.YCE_PRERANK_INDEX_MIN_DOCS = "0";
  Object.assign(process.env, overrides);
  indexTest.clearMemoryCache();
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    indexTest.clearMemoryCache();
    rmSync(indexDir, { recursive: true, force: true });
  });
  return indexDir;
}

function run(root, query = "select upstream key from lease pool") {
  indexTest.clearMemoryCache();
  return scoreFiles(query, root, ["src"], [], { maxResults: 10, candidateLimit: 80 });
}

function comparable(result) {
  const {
    indexMode,
    indexHits,
    indexMisses,
    indexLoadMs,
    indexSaveMs,
    elapsedMs,
    ...rest
  } = result;
  return rest;
}

function disabledRun(root, query) {
  const previous = process.env.YCE_PRERANK_INDEX;
  process.env.YCE_PRERANK_INDEX = "0";
  try { return run(root, query); }
  finally {
    if (previous === undefined) delete process.env.YCE_PRERANK_INDEX;
    else process.env.YCE_PRERANK_INDEX = previous;
  }
}

test("YCE_PRERANK_INDEX=0 keeps the pre-change scoring path", (t) => {
  const root = makeFixture(t);
  const indexDir = useIndexEnv(t, { YCE_PRERANK_INDEX: "0" });
  const result = run(root);
  assert.equal(result.indexMode, "off");
  assert.equal(result.indexHits, 0);
  assert.equal(result.indexMisses, 0);
  assert.equal(result.indexLoadMs, 0);
  assert.equal(result.indexSaveMs, 0);
  assert.deepEqual(readFileNames(indexDir), []);
});

test("cold and warm index runs score identically to the disabled path", (t) => {
  const root = makeFixture(t);
  useIndexEnv(t);
  const off = disabledRun(root);
  const cold = run(root);
  const warm = run(root);
  assert.deepEqual(comparable(cold), comparable(off));
  assert.deepEqual(comparable(warm), comparable(off));
  assert.equal(cold.indexHits, 0);
  assert.equal(warm.indexMisses, 0);
  assert.ok(warm.indexHits > 0);
  assert.equal(warm.indexMode, "disk");
  assert.equal(JSON.parse(readFileSync(prerankIndexPath(root), "utf-8")).version, PRERANK_INDEX_VERSION);
});

test("a changed file invalidates its index entry", (t) => {
  const root = makeFixture(t);
  useIndexEnv(t);
  run(root);
  const target = join(root, "src", "lease_scheduler.js");
  const original = readFileSync(target, "utf-8");
  const changed = original.replace("selectUpstreamKey", "chooseUpstreamKey");
  assert.equal(changed.length, original.length);
  writeFileSync(target, changed);
  const now = new Date();
  utimesSync(target, now, new Date(now.getTime() + 5000));
  const warm = run(root, "choose upstream key from lease pool");
  const off = disabledRun(root, "choose upstream key from lease pool");
  assert.equal(warm.indexMisses, 1);
  assert.deepEqual(comparable(warm), comparable(off));
});

test("a corrupt index file is ignored and rebuilt", (t) => {
  const root = makeFixture(t);
  useIndexEnv(t);
  mkdirSync(dirname(prerankIndexPath(root)), { recursive: true });
  writeFileSync(prerankIndexPath(root), "{ not json");
  const result = run(root);
  assert.equal(result.indexHits, 0);
  assert.deepEqual(comparable(result), comparable(disabledRun(root)));
  const saved = JSON.parse(readFileSync(prerankIndexPath(root), "utf-8"));
  assert.equal(saved.version, PRERANK_INDEX_VERSION);
  assert.equal(saved.tokenizerVersion, TOKENIZER_VERSION);
  assert.equal(saved.projectRoot, resolve(root));
});

test("a structurally corrupt matching entry is treated as a miss and rebuilt", (t) => {
  const root = makeFixture(t);
  useIndexEnv(t);
  const cold = run(root);
  const indexPath = prerankIndexPath(root);
  const saved = JSON.parse(readFileSync(indexPath, "utf-8"));
  saved.entries["src/lease_scheduler.js"].decl = { bad: true };
  writeFileSync(indexPath, JSON.stringify(saved));
  indexTest.clearMemoryCache();

  const repaired = run(root);
  const off = disabledRun(root);
  assert.equal(repaired.indexMisses, 1);
  assert.equal(repaired.indexHits, cold.indexMisses - 1);
  assert.deepEqual(comparable(repaired), comparable(off));
  const rewritten = JSON.parse(readFileSync(indexPath, "utf-8"));
  assert.ok(Array.isArray(rewritten.entries["src/lease_scheduler.js"].decl));
});

test("a matching entry with a nested term-frequency value is rebuilt", (t) => {
  const root = makeFixture(t);
  useIndexEnv(t);
  const cold = run(root);
  const indexPath = prerankIndexPath(root);
  const saved = JSON.parse(readFileSync(indexPath, "utf-8"));
  saved.entries["src/lease_scheduler.js"].tf.lease = { toString: null, valueOf: null };
  writeFileSync(indexPath, JSON.stringify(saved));
  indexTest.clearMemoryCache();

  const repaired = run(root);
  const off = disabledRun(root);
  assert.equal(repaired.indexMisses, 1);
  assert.equal(repaired.indexHits, cold.indexMisses - 1);
  assert.deepEqual(comparable(repaired), comparable(off));
  const rewritten = JSON.parse(readFileSync(indexPath, "utf-8"));
  assert.equal(typeof rewritten.entries["src/lease_scheduler.js"].tf.lease, "number");
});

test("an index written by another tokenizer version is discarded", (t) => {
  const root = makeFixture(t);
  useIndexEnv(t);
  const target = join(root, "src", "lease_scheduler.js");
  const stat = statSync(target);
  mkdirSync(dirname(prerankIndexPath(root)), { recursive: true });
  writeFileSync(prerankIndexPath(root), JSON.stringify({
    version: PRERANK_INDEX_VERSION,
    tokenizerVersion: `${TOKENIZER_VERSION}-future`,
    projectRoot: resolve(root),
    entries: {
      "src/lease_scheduler.js": {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        len: 1,
        tf: { lease: 9999 },
        decl: [],
        beh: [],
        seenAt: Date.now(),
      },
    },
  }));
  const result = run(root);
  assert.equal(result.indexHits, 0);
  assert.deepEqual(comparable(result), comparable(disabledRun(root)));
});

test("the size guard keeps the index in memory", (t) => {
  const root = makeFixture(t);
  useIndexEnv(t, { YCE_PRERANK_INDEX_MAX_BYTES: "64" });
  const result = run(root);
  assert.equal(result.indexMode, "memory");
  assert.equal(existsSync(prerankIndexPath(root)), false);
  assert.deepEqual(comparable(result), comparable(disabledRun(root)));
});

test("an unwritable cache directory degrades to memory", (t) => {
  const root = makeFixture(t);
  const indexDir = useIndexEnv(t);
  const regularFile = join(indexDir, "regular-file");
  writeFileSync(regularFile, "x");
  process.env.YCE_PRERANK_INDEX_DIR = join(regularFile, "sub");
  const result = run(root);
  assert.equal(result.indexMode, "memory");
  assert.deepEqual(comparable(result), comparable(disabledRun(root)));
});

test("entries older than the prune window are dropped on save", (t) => {
  const root = makeFixture(t);
  useIndexEnv(t);
  const indexPath = prerankIndexPath(root);
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify({
    version: PRERANK_INDEX_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    projectRoot: resolve(root),
    entries: {
      "ghost/gone.js": { size: 1, mtimeMs: 1, skip: 1, seenAt: Date.now() - 8 * 86400000 },
    },
  }));
  run(root);
  const saved = JSON.parse(readFileSync(indexPath, "utf-8"));
  assert.equal(saved.entries["ghost/gone.js"], undefined);
  assert.ok(saved.entries["src/lease_scheduler.js"]);
});

test("binary and empty files are skipped without a second read", (t) => {
  const root = makeFixture(t);
  useIndexEnv(t);
  const cold = run(root);
  const saved = JSON.parse(readFileSync(prerankIndexPath(root), "utf-8"));
  assert.equal(saved.entries["src/binary.bin"].skip, 1);
  assert.equal(saved.entries["src/empty.js"], undefined);
  assert.equal(saved.entries["src/huge.js"], undefined);
  const warm = run(root);
  assert.ok(warm.indexHits > 0);
  assert.equal(cold.candidatePool.some((entry) => entry.path.endsWith("binary.bin")), false);
  assert.equal(warm.candidatePool.some((entry) => entry.path.endsWith("empty.js")), false);
});

test("query terms that collide with Object.prototype keys score identically", (t) => {
  const root = makeFixture(t);
  useIndexEnv(t);
  writeFileSync(
    join(root, "src", "lease_pool.js"),
    "export class LeasePool { constructor(pool) { this.pool = pool; } }\n",
  );
  const off = disabledRun(root, "constructor lease pool");
  run(root, "constructor lease pool");
  const warm = run(root, "constructor lease pool");
  assert.deepEqual(comparable(warm), comparable(off));
});

test("a repository below the minimum document count is not persisted", (t) => {
  const root = makeFixture(t, { files: 2 });
  useIndexEnv(t, {}, { defaultMinDocs: true });
  const result = run(root);
  assert.equal(result.indexMode, "memory");
  assert.equal(existsSync(prerankIndexPath(root)), false);
});

test("index stats are reported when no document survives collection", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yce-prerank-index-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  useIndexEnv(t);
  const result = run(root);
  assert.deepEqual(result.candidatePool, []);
  for (const key of ["indexHits", "indexMisses", "indexLoadMs", "indexSaveMs"]) {
    assert.equal(typeof result[key], "number");
  }
  assert.equal(typeof result.indexMode, "string");
});

function readFileNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}
