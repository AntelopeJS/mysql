#!/usr/bin/env bash
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
if [[ -z "${DECORATORS_TEST_API_PORT:-}" ]]; then
  DECORATORS_TEST_API_PORT=$(node -e '
const server = require("node:net").createServer();
server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
  server.close();
});
') || exit 1
  export DECORATORS_TEST_API_PORT
fi
source=$(cd "$root" && node -p 'path.dirname(require.resolve("@antelopejs/interface-database-decorators/package.json"))')
dependencies=$(dirname "$(dirname "$source")")
wrapper=$(mktemp -d "${TMPDIR:-/tmp}/ajs-mysql-decorators.XXXXXX")
trap 'rm -rf "$wrapper"' EXIT
cp -R "$source/dist" "$wrapper/dist"
mkdir -p "$wrapper/node_modules/@antelopejs"
for entry in "$dependencies"/* "$dependencies"/@antelopejs/*; do
  name=${entry#"$dependencies"/}
  case $name in
    @antelopejs | @antelopejs/interface-database-decorators) ;;
    *) ln -s "$entry" "$wrapper/node_modules/$name" ;;
  esac
done
ln -s "$root/node_modules/chai" "$wrapper/node_modules/chai"
node -e '
const fs = require("node:fs");
const [manifest, config, target] = process.argv.slice(1);
const pack = JSON.parse(fs.readFileSync(manifest, "utf8"));
pack.antelopeJs.test = config;
fs.writeFileSync(target, JSON.stringify(pack));
' "$source/package.json" "$root/src/test/antelope.test.ts" "$wrapper/package.json"
cd "$wrapper" && MYSQL_TEST_MODE=decorators "$root/node_modules/.bin/ajs" module test .
