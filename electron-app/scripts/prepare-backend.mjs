// electron-app/scripts/prepare-backend.mjs
// Stages the backend inside the desktop app.
//
// The desktop application runs exactly the same code as the server
// deployment, so before packaging (and before a development run) the
// backend sources and their production dependencies are copied into
// electron-app/backend and electron-app/node_modules.
//
// Nothing is downloaded: the copy is made from the repository's own
// node_modules, so the build works offline and always matches the
// versions the repository was tested with.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "..");

const backendTarget = path.join(appRoot, "backend");
const modulesTarget = path.join(appRoot, "node_modules");

const BACKEND_FILES = [
  "src",
  "providers",
  "dashboard",
  "db.js",
  "ai.js",
  "crypto-utils.js",
  "index.js",
  "seed.js",
  "webhooks.js",
  "package.json",
];

const BACKEND_SKIP = new Set([
  "node_modules",
  ".git",
  "test",
  "dist",
  "electron-app",
  "auth_info",
  "backups",
  "logs",
]);

// Inside node_modules only build caches are skipped: a package's own
// `dist` directory is its published code.
const MODULE_SKIP = new Set([".bin", ".cache", ".package-lock.json"]);

// The app package.json declares the same runtime dependencies as the
// repository so that the packager knows what to ship; the actual files
// come from the copy below. Refuse to build when the two lists differ,
// because a missing declaration silently drops packages from the asar.
function checkRuntimeDependencies() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const appPkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  const expected = { ...(rootPkg.dependencies || {}), ...(rootPkg.optionalDependencies || {}) };
  const actual = appPkg.dependencies || {};
  const missing = Object.keys(expected).filter((name) => !(name in actual));
  const extra = Object.keys(actual).filter((name) => !(name in expected));
  const drifted = Object.keys(expected).filter((name) => name in actual && actual[name] !== expected[name]);
  if (missing.length || extra.length || drifted.length) {
    const lines = [];
    if (missing.length) lines.push(`  missing in electron-app/package.json: ${missing.join(", ")}`);
    if (extra.length) lines.push(`  not a repository dependency: ${extra.join(", ")}`);
    if (drifted.length) lines.push(`  version differs: ${drifted.join(", ")}`);
    throw new Error(
      `The desktop app's dependency list does not match the repository:\n${lines.join("\n")}`
    );
  }
  return Object.keys(expected).length;
}

function copyRecursive(from, to, skip = BACKEND_SKIP) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (skip.has(entry)) continue;
      copyRecursive(path.join(from, entry), path.join(to, entry), skip);
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyModules() {
  const source = path.join(repoRoot, "node_modules");
  if (!fs.existsSync(source)) {
    console.warn(
      "The repository has no node_modules yet. Run `npm install` in the repository root before packaging."
    );
    return 0;
  }
  fs.mkdirSync(modulesTarget, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(source)) {
    // The Electron runtime and the packager are development tools: they
    // are never part of the shipped application.
    if (entry === "electron" || entry === "electron-builder" || entry === ".bin") continue;
    const from = path.join(source, entry);
    const to = path.join(modulesTarget, entry);
    // Replace rather than merge: a package that already exists in the
    // desktop app's node_modules (pulled in by the packager's own
    // toolchain) may have a different file layout for the same version.
    // Overlaying the two produces a broken package.
    fs.rmSync(to, { recursive: true, force: true });
    copyRecursive(from, to, MODULE_SKIP);
    count += 1;
  }
  return count;
}

console.log("Staging the backend for the desktop application…");

const dependencyCount = checkRuntimeDependencies();
console.log(`  = runtime dependencies (${dependencyCount} declared)`);

fs.rmSync(backendTarget, { recursive: true, force: true });
fs.mkdirSync(backendTarget, { recursive: true });

for (const entry of BACKEND_FILES) {
  const from = path.join(repoRoot, entry);
  if (!fs.existsSync(from)) {
    console.warn(`  skipped (not found): ${entry}`);
    continue;
  }
  copyRecursive(from, path.join(backendTarget, entry));
  console.log(`  + backend/${entry}`);
}

const moduleCount = copyModules();
console.log(`  + node_modules (${moduleCount} packages)`);

console.log("Done. Run `npm run desktop` for a development build.");
