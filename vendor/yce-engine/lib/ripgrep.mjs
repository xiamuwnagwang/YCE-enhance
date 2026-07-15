import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolveRipgrepPath() {
  const arch = process.env.npm_config_arch || process.arch;
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;

  try {
    return require.resolve(`${platformPkg}/bin/${binaryName}`);
  } catch {
    // Packaged installs may carry node_modules from another platform. In that
    // case do not fail during module import; let the command fall back to a
    // system rg if available, while install scripts can repair node_modules.
  }

  try {
    return require.resolve(`@vscode/ripgrep/bin/${binaryName}`);
  } catch {
    return "rg";
  }
}
