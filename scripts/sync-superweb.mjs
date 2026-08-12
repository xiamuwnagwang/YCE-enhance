#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const sharedSource = process.env.SUPERWEB_SHARED_SOURCE
  || path.resolve(process.cwd(), "../yce-relay-frontend-main/shared/superweb");
const hasTarget = args.some((arg) => arg === "--target" || arg.startsWith("--target="));
const target = process.env.SUPERWEB_YCE_TARGET;

if (!hasTarget && !target) {
  process.stderr.write(
    "请显式提供 --target <YCE 运行时 Superweb 目录>，或设置 SUPERWEB_YCE_TARGET；避免误覆盖其他目录。\n",
  );
  process.exitCode = 2;
} else {
  if (!args.some((arg) => arg === "--source" || arg.startsWith("--source="))) {
    args.push("--source", sharedSource);
  }
  if (!hasTarget) args.push("--target", target);
  process.argv = [process.argv[0], path.join(sharedSource, "sync.mjs"), ...args];
  await import(pathToFileURL(path.join(sharedSource, "sync.mjs")).href);
}
