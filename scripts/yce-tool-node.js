#!/usr/bin/env node
'use strict';

// yce-tool-node.js — Node.js implementation of yce-tool-rs for Linux/unsupported platforms
// Implements the same CLI interface: --config, --search-context, --max-lines-per-blob, etc.
// API protocol confirmed via endpoint testing against yce.aigy.de/relay/

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const USER_AGENT = 'augment.cli/0.12.0/cli';

// ─── CLI ────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    config: null,
    searchContext: null,
    enhancePrompt: null,
    indexOnly: false,
    maxLinesPerBlob: 800,
    uploadTimeout: 120,
    uploadConcurrency: 4,
    retrievalTimeout: 60,
    noAdaptive: false,
    noWebbrowserEnhancePrompt: false,
    clearConfigCache: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg.includes('=')) {
      const eqIdx = arg.indexOf('=');
      const key = arg.substring(0, eqIdx);
      const val = arg.substring(eqIdx + 1);
      switch (key) {
        case '--config': opts.config = val; continue;
        case '--search-context': opts.searchContext = val; continue;
        case '--enhance-prompt': opts.enhancePrompt = val; continue;
        case '--max-lines-per-blob': opts.maxLinesPerBlob = parseInt(val, 10) || 800; continue;
        case '--upload-timeout': opts.uploadTimeout = parseInt(val, 10) || 120; continue;
        case '--upload-concurrency': opts.uploadConcurrency = parseInt(val, 10) || 4; continue;
        case '--retrieval-timeout': opts.retrievalTimeout = parseInt(val, 10) || 60; continue;
      }
    }

    switch (arg) {
      case '--config': opts.config = next; i++; break;
      case '--search-context': opts.searchContext = next; i++; break;
      case '--enhance-prompt': opts.enhancePrompt = next; i++; break;
      case '--index-only': opts.indexOnly = true; break;
      case '--max-lines-per-blob': opts.maxLinesPerBlob = parseInt(next, 10) || 800; i++; break;
      case '--upload-timeout': opts.uploadTimeout = parseInt(next, 10) || 120; i++; break;
      case '--upload-concurrency': opts.uploadConcurrency = parseInt(next, 10) || 4; i++; break;
      case '--retrieval-timeout': opts.retrievalTimeout = parseInt(next, 10) || 60; i++; break;
      case '--no-adaptive': opts.noAdaptive = true; break;
      case '--no-webbrowser-enhance-prompt': opts.noWebbrowserEnhancePrompt = true; break;
      case '--clear-config-cache': opts.clearConfigCache = true; break;
    }
  }
  return opts;
}

// ─── Config ─────────────────────────────────────────────────────────────────────

function loadConfig(configPath) {
  const candidates = configPath
    ? [configPath]
    : ['ace-tool.json', '.ace-tool.json'];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  throw new Error(`Configuration file not found: ${configPath || 'ace-tool.json'}`);
}

function normalizeBaseUrl(raw) {
  if (!raw) throw new Error('base_url is required in config');
  let url = raw.trim();
  try {
    const parsed = new URL(url);
    const p = parsed.pathname || '';
    if (p === '' || p === '/' || /^\/api\/v1\/\.\.\/\.\.\/?$/.test(p)) {
      parsed.pathname = '/relay/';
      url = parsed.toString();
    } else if (p === '/relay' || /^\/relay\/+$/.test(p)) {
      parsed.pathname = '/relay/';
      url = parsed.toString();
    }
  } catch {
    throw new Error(`Invalid base_url: ${url}`);
  }
  if (!url.endsWith('/')) url += '/';
  return url;
}

// ─── File Scanner ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
  '.idea', '.vscode', '.vs', 'dist', 'build', 'target', 'out',
  '.next', '.nuxt', '.svelte-kit', 'coverage', '.tox', '.nox',
  'vendor', '.bundle', 'bower_components', '.cache', '.parcel-cache',
  '.eggs', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.terraform', '.serverless', 'cdk.out',
]);

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
  '.py', '.pyw', '.pyx', '.pxd',
  '.rs', '.go', '.java', '.kt', '.kts', '.scala', '.clj', '.cljs',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.hh',
  '.cs', '.fs', '.fsx', '.vb',
  '.rb', '.erb', '.rake', '.gemspec',
  '.php', '.phtml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
  '.lua', '.r', '.jl', '.ex', '.exs', '.erl', '.hrl',
  '.swift', '.m', '.mm', '.dart', '.zig', '.nim', '.v', '.d',
  '.sql', '.graphql', '.gql', '.prisma',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.xml', '.xsl', '.svg',
  '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.md', '.mdx', '.rst', '.txt', '.tex',
  '.tf', '.hcl', '.proto', '.thrift',
  '.gradle', '.groovy', '.sbt', '.cmake',
  '.editorconfig', '.eslintrc', '.prettierrc',
  '.gitignore', '.dockerignore', '.npmignore',
  '.env.example',
]);

const EXACT_NAMES = new Set([
  'Makefile', 'makefile', 'GNUmakefile',
  'Dockerfile', 'Containerfile', 'Procfile',
  'Rakefile', 'Gemfile', 'Brewfile', 'Vagrantfile',
  'Justfile', 'justfile', 'CMakeLists.txt',
  'setup.py', 'setup.cfg', 'pyproject.toml', 'requirements.txt',
  'package.json', 'tsconfig.json',
  'Cargo.toml', 'go.mod', 'go.sum',
  'build.gradle', 'pom.xml',
  '.babelrc', '.huskyrc',
]);

function loadGitignoreRules(dir) {
  const p = path.join(dir, '.gitignore');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function matchesGitignore(relPath, rules) {
  for (const rule of rules) {
    if (rule.startsWith('!')) continue;
    const pat = rule.endsWith('/') ? rule.slice(0, -1) : rule;
    if (pat.includes('/')) {
      if (relPath.startsWith(pat + '/') || relPath === pat) return true;
    } else {
      const parts = relPath.split('/');
      for (const part of parts) {
        if (part === pat) return true;
        if (pat.startsWith('*.') && part.endsWith(pat.slice(1))) return true;
        if (pat.includes('*') && simpleGlob(part, pat)) return true;
      }
    }
  }
  return false;
}

function simpleGlob(str, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${escaped}$`).test(str);
  } catch {
    return str === pattern;
  }
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (EXACT_NAMES.has(path.basename(filePath))) return true;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    if (n === 0) return false;
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0) return false;
    }
    return buf[0] === 0x23 && buf[1] === 0x21; // shebang
  } catch {
    return false;
  }
}

function scanFiles(dir, maxLines) {
  const blobNames = [];
  const blobs = [];
  const rules = loadGitignoreRules(dir);
  const maxFileSize = 1024 * 1024; // 1 MB

  function walk(cur, prefix) {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      const name = e.name;
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = path.join(cur, name);

      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        if (matchesGitignore(rel + '/', rules)) continue;
        walk(full, rel);
      } else if (e.isFile()) {
        if (matchesGitignore(rel, rules)) continue;
        if (!isTextFile(full)) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.size > maxFileSize || stat.size === 0) continue;
          const content = fs.readFileSync(full, 'utf-8');
          const lines = content.split('\n');
          for (let start = 0; start < lines.length; start += maxLines) {
            const chunk = lines.slice(start, start + maxLines).join('\n');
            if (!chunk.trim()) continue;
            blobNames.push(rel);
            blobs.push({ content: chunk, name: rel });
          }
        } catch { /* skip */ }
      }
    }
  }

  walk(dir, '');
  return { blobNames, blobs };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────────

function httpPost(url, headers, body, timeoutSec) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const payload = typeof body === 'string' ? body : JSON.stringify(body);

    const req = mod.request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutSec * 1000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 1000)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout after ${timeoutSec}s`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function makeHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'x-request-id': crypto.randomUUID(),
  };
}

// ─── API ────────────────────────────────────────────────────────────────────────

async function batchUpload(baseUrl, token, blobNames, blobs, opts) {
  const batchSize = opts.uploadConcurrency || 4;
  const timeout = opts.uploadTimeout || 120;

  for (let i = 0; i < blobs.length; i += batchSize * 50) {
    const end = Math.min(i + batchSize * 50, blobs.length);
    const batchBlobs = blobs.slice(i, end);
    const batchNames = blobNames.slice(i, end);

    await httpPost(
      `${baseUrl}batch-upload`,
      makeHeaders(token),
      { blob_names: batchNames, blobs: batchBlobs },
      timeout,
    );
  }
}

async function searchCodebase(baseUrl, token, query, opts) {
  const body = {
    search_context: query,
    chat_history: [],
    user_guided_blobs: [],
  };

  if (opts.noAdaptive) body.disable_codebase_retrieval = false;

  const resp = await httpPost(
    `${baseUrl}agents/codebase-retrieval`,
    makeHeaders(token),
    body,
    opts.retrievalTimeout || 60,
  );

  try {
    const parsed = JSON.parse(resp.body);
    return parsed.formatted_retrieval || parsed.result || parsed.response || resp.body;
  } catch {
    return resp.body;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.searchContext && !opts.enhancePrompt && !opts.indexOnly) {
    process.stderr.write(
      'Usage: yce-tool-node --config <path> --search-context "<query>" [options]\n'
    );
    process.exit(1);
  }

  const config = loadConfig(opts.config);
  const baseUrl = normalizeBaseUrl(config.base_url);
  const token = config.token;

  if (!token) {
    process.stderr.write('Auth error: token is required in config\n');
    process.exit(1);
  }

  const cwd = process.cwd();

  // Scan
  process.stderr.write('Scanning files...\n');
  const { blobNames, blobs } = scanFiles(cwd, opts.maxLinesPerBlob);

  if (blobs.length === 0) {
    process.stderr.write('No text files found in project\n');
    if (!opts.searchContext) {
      process.exit(0);
    }
  } else {
    // Upload
    process.stderr.write(`Uploading ${blobs.length} blobs...\n`);
    try {
      await batchUpload(baseUrl, token, blobNames, blobs, opts);
    } catch (err) {
      process.stderr.write(`Upload failed: ${err.message}\n`);
    }
  }

  if (opts.indexOnly) {
    process.stderr.write('Index complete\n');
    process.exit(0);
  }

  if (opts.searchContext) {
    process.stderr.write(`Search-context mode: searching for '${opts.searchContext}'\n`);
    try {
      const result = await searchCodebase(baseUrl, token, opts.searchContext, opts);

      if (!result || !String(result).trim()) {
        process.stderr.write('No relevant code context found for your query.\n');
        process.exit(3);
      }

      process.stderr.write('Search complete\n');
      process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
      process.stdout.write('\n');
    } catch (err) {
      process.stderr.write(`Search failed: ${err.message}\n`);
      process.exit(5);
    }
  }
}

main().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
