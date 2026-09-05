#!/usr/bin/env node
/**
 * Sync the version across the main package and its platform companion
 * packages. Usage: node scripts/set-version.js <version>
 *
 * Updates in place:
 *   - package.json "version"                        (main package)
 *   - package.json "optionalDependencies" versions  (@sukeai/pi-logfwd-*)
 * Companion packages read their own version from the same variable in
 * release.sh, so keep them in lockstep.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
	console.error("usage: node scripts/set-version.js <semver, e.g. 0.1.0>");
	process.exit(1);
}

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
for (const key of Object.keys(pkg.optionalDependencies || {})) {
	pkg.optionalDependencies[key] = version;
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
console.log(`package.json: version=${version}, optionalDependencies -> ${Object.keys(pkg.optionalDependencies).join(", ")}`);
