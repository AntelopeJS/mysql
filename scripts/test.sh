#!/usr/bin/env bash
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 1
images=${MYSQL_TEST_IMAGES:-mysql:8.4 mysql:9.7 mariadb:11.8 mariadb:12.3}
parallel=${MYSQL_TEST_PARALLEL:-2}
servers=${MYSQL_TEST_SERVERS:-4}
record=${MYSQL_TEST_TIMES:-}
prefix=${MYSQL_TEST_CONTAINER_PREFIX:-ajs-mysql-test}
password=antelopejs-test
weights="$root/scripts/test-times.tsv"
logs=$(mktemp -d "${TMPDIR:-/tmp}/ajs-mysql-test.XXXXXX")
ajs="$root/node_modules/.bin/ajs"
shard=${ANTELOPEJS_CI_SHARD:-1/1}
if [[ ! $shard =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || ((BASH_REMATCH[1] > BASH_REMATCH[2])); then
  echo "ANTELOPEJS_CI_SHARD must be <shard>/<count>, such as 2/4, not $shard" >&2
  exit 2
fi
shard_index=$((BASH_REMATCH[1] - 1)) shard_count=${BASH_REMATCH[2]}
if [[ ! $servers =~ ^[1-9][0-9]*$ ]]; then
  echo "MYSQL_TEST_SERVERS must be a whole number of at least 1, not $servers" >&2
  exit 2
fi
read -ra all_images <<<"$images"
images=""
for i in "${!all_images[@]}"; do
  ((i % shard_count == shard_index)) && images+="${all_images[i]} "
done
if [[ ${1:-} == --build ]]; then
  if [[ -z ${MYSQL_TEST_URL:-} ]]; then
    for image in $images; do
      docker pull -q "$image" >/dev/null 2>&1 &
    done
  fi
  pnpm run --silent build || exit 1
  wait
fi

node -e '
const fs = require("node:fs");
const path = require("node:path");
const pattern = /\.(test|spec)\.(js|ts)$/;
const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(file) : pattern.test(entry.name) ? [file] : [];
      })
    : [];
for (const file of walk("dist/test")) {
  console.log(`${path.dirname(file) === path.join("dist", "test") ? path.basename(file) : "rest"}\t${file}`);
}
for (const name of require("./package.json").antelopeJs?.implements ?? []) {
  let dir = path.dirname(require.resolve(name, { paths: ["."] }));
  while (!fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
  for (const file of walk(path.join(dir, "dist", "tests"))) console.log(`rest\t${file}`);
}
' >"$logs/files" || exit 1
if ! grep -q $'\t'dist/test/ "$logs/files"; then
  echo "no test files under dist/test; run pnpm run build first" >&2
  exit 1
fi
{
  cut -f1 "$logs/files" | sort -u
  printf '%s\n' external decorators chains
} >"$logs/units"

awk -F'\t' -v servers="$servers" '
  FILENAME == ARGV[1] { weight[$2] = $1; if ($1 > top) top = $1; next }
  { units[++n] = $1; w[n] = ($1 in weight) ? weight[$1] : top + 1 }
  END {
    for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++)
      if (w[j] > w[i] || (w[j] == w[i] && units[j] < units[i])) { t = w[i]; w[i] = w[j]; w[j] = t; t = units[i]; units[i] = units[j]; units[j] = t }
    for (i = 1; i <= n; i++) {
      best = 1
      for (s = 2; s <= servers; s++) if (load[s] < load[best]) best = s
      load[best] += w[i]
      print best "\t" units[i]
    }
  }
' "$weights" "$logs/units" >"$logs/plan"

run_unit() {
  local url=$1 unit=$2 args=() file
  case "$unit" in
    external) MYSQL_TEST_URL=$url pnpm run --silent test:external:run ;;
    decorators) MYSQL_TEST_URL=$url scripts/decorators.sh ;;
    chains) MYSQL_TEST_URL=$url node .agents/skills/formal-pipeline-chains/check.mjs --no-build ;;
    *)
      while read -r file; do args+=(-f "$file"); done < <(awk -F'\t' -v units=" $unit " 'index(units, " " $1 " ") { print $2 }' "$logs/files")
      MYSQL_TEST_URL=$url "$ajs" module test . "${args[@]}"
      ;;
  esac
}

run_bin() {
  local url=$1 label=$2 bin=$3 b unit owned=() suites=() batch passing started
  while IFS=$'\t' read -r b unit; do
    [[ $b == "$bin" ]] || continue
    case "$unit" in
      external | decorators | chains) suites+=("$unit") ;;
      *) owned+=("$unit") ;;
    esac
  done <"$logs/plan"
  if [[ -n $record ]]; then
    batch=("${owned[@]}" "${suites[@]}")
  else
    batch=("${owned[*]}" "${suites[@]}")
  fi
  for unit in "${batch[@]}"; do
    [[ -n $unit ]] || continue
    local name=${unit%% *} log
    case "$name" in external | decorators | chains) ;; *) name=owned ;; esac
    log="$label.$bin.$name"
    started=$SECONDS
    run_unit "$url" "$unit" >>"$logs/$log.log" 2>&1 || { grep -qx "$log" "$logs/failed" 2>/dev/null || echo "$log" >>"$logs/failed"; }
    [[ -n $record ]] && printf '%s\t%s\n' "$((SECONDS - started))" "$unit" >>"$logs/times"
  done
  if [[ -n ${GITHUB_ACTIONS:-} ]]; then
    for name in owned "${suites[@]}"; do
      [[ -f "$logs/$label.$bin.$name.log" ]] || continue
      passing=$(grep -aoE '[0-9]+ passing' "$logs/$label.$bin.$name.log" | awk '{ sum += $1 } END { print sum + 0 }')
      echo "::notice title=Tests of shard $shard::$label server $bin $name: $passing passing"
    done
  fi
}

start_server() {
  local image=$1 name=$2 tries=0 port client=mysql args=()
  [[ $image == *mariadb* ]] && client=mariadb args=(--log-bin=mariadb-bin --server-id=1)
  docker run -d --rm --name "$name" --tmpfs /var/lib/mysql -e MYSQL_ROOT_PASSWORD="$password" -p 127.0.0.1::3306 "$image" "${args[@]}" >/dev/null || return 1
  until docker exec "$name" "$client" -uroot -p"$password" -h127.0.0.1 -e 'SELECT 1' >/dev/null 2>&1; do
    tries=$((tries + 1))
    [[ $tries -gt 180 ]] && return 1
    sleep 1
  done
  port=$(docker port "$name" 3306/tcp | head -n 1)
  echo "mysql://root:$password@127.0.0.1:${port##*:}/mysql"
}

run_server() {
  local image=$1 label=$2 bin=$3 url
  local name="$prefix-$label-$bin-$$"
  echo "$name" >>"$logs/containers"
  if ! url=$(start_server "$image" "$name" 2>"$logs/$label.$bin.server.log"); then
    echo "$label.$bin.server" >>"$logs/failed"
    return
  fi
  run_bin "$url" "$label" "$bin"
  docker rm -f "$name" >/dev/null 2>&1
}

run_image() {
  local image=$1 label=${1//[^a-zA-Z0-9]/-} bin
  for ((bin = 1; bin <= servers; bin++)); do
    run_server "$image" "$label" "$bin" &
  done
  wait
}

finish() {
  trap '' INT TERM HUP
  for job in $(jobs -p); do
    kill -TERM -- "-$job" 2>/dev/null
  done
  wait
  if [[ -f "$logs/containers" ]]; then
    xargs docker rm -f <"$logs/containers" >/dev/null 2>&1
  fi
  local status=$1 failed
  if [[ -f "$logs/failed" ]]; then
    status=1
    while read -r failed; do
      echo "=== $failed ==="
      cat "$logs/$failed.log"
    done <"$logs/failed"
  fi
  if [[ -n $record && -f "$logs/times" ]]; then
    awk -F'\t' '$1 > top[$2] || !($2 in top) { top[$2] = $1 } END { for (unit in top) print top[unit] "\t" unit }' "$logs/times" | sort -k1,1nr -k2 >"$record"
  fi
  rm -rf "$logs"
  exit "$status"
}
trap 'finish 130' INT
trap 'finish 143' TERM
trap 'finish 129' HUP

if ((shard_index == 0)); then
  "$root/node_modules/.bin/mocha" "dist/test/unit/**/*.spec.js" >"$logs/unit.log" 2>&1 || echo unit >>"$logs/failed"
fi
if [[ -n "${MYSQL_TEST_URL:-}" ]]; then
  if ((shard_index == 0)); then
    servers=1
    awk -F'\t' '{ print "1\t" $2 }' "$logs/plan" >"$logs/plan.one" && mv "$logs/plan.one" "$logs/plan"
    run_bin "$MYSQL_TEST_URL" url 1
  fi
  finish 0
fi
set -m
for image in $images; do
  while [[ $(jobs -rp | wc -l) -ge $parallel ]]; do
    wait -n
  done
  run_image "$image" &
done
set +m
wait
finish 0
