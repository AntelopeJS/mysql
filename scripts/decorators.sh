#!/usr/bin/env bash
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source=$(cd "$root" && node -p 'path.dirname(require.resolve("@antelopejs/interface-database-decorators/package.json"))')
wrapper=$(mktemp -d "${TMPDIR:-/tmp}/ajs-mysql-decorators.XXXXXX")
trap 'rm -rf "$wrapper"' EXIT
cp -R "$source/dist" "$wrapper/dist"
ln -s "$root/node_modules" "$wrapper/node_modules"
node -e '
const fs = require("node:fs");
const [manifest, config, target] = process.argv.slice(1);
const pack = JSON.parse(fs.readFileSync(manifest, "utf8"));
pack.antelopeJs.test = config;
fs.writeFileSync(target, JSON.stringify(pack));
' "$source/package.json" "$root/src/test/antelope.test.ts" "$wrapper/package.json"
cd "$wrapper" && MYSQL_TEST_MODE=decorators "$root/node_modules/.bin/ajs" module test .
