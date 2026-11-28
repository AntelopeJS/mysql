#!/usr/bin/env bash
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 1
images=${MYSQL_TEST_IMAGES:-mysql:8.4 mysql:9.7 mariadb:11.8 mariadb:12.3}
parallel=${MYSQL_TEST_PARALLEL:-2}
prefix=${MYSQL_TEST_CONTAINER_PREFIX:-ajs-mysql-test}
password=antelopejs-test
suites=(owned external decorators chains)
logs=$(mktemp -d "${TMPDIR:-/tmp}/ajs-mysql-test.XXXXXX")
ajs="$root/node_modules/.bin/ajs"
shard=${ANTELOPEJS_CI_SHARD:-1/1}
if [[ ! $shard =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || ((BASH_REMATCH[1] > BASH_REMATCH[2])); then
  echo "ANTELOPEJS_CI_SHARD must be <shard>/<count>, such as 2/4, not $shard" >&2
  exit 2
fi
shard_index=$((BASH_REMATCH[1] - 1)) shard_count=${BASH_REMATCH[2]}
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

run_suite() {
  case "$2" in
    owned) MYSQL_TEST_URL=$1 "$ajs" module test . ;;
    external) MYSQL_TEST_URL=$1 pnpm run --silent test:external:run ;;
    decorators) MYSQL_TEST_URL=$1 scripts/decorators.sh ;;
    chains) MYSQL_TEST_URL=$1 node .agents/skills/formal-pipeline-chains/check.mjs --no-build ;;
  esac
}

run_suites() {
  local url=$1 label=$2 suite passing
  for suite in "${suites[@]}"; do
    run_suite "$url" "$suite" >"$logs/$label.$suite.log" 2>&1 || echo "$label.$suite" >>"$logs/failed"
    if [[ -n ${GITHUB_ACTIONS:-} ]]; then
      passing=$(grep -aoE '[0-9]+ passing' "$logs/$label.$suite.log" | awk '{ sum += $1 } END { print sum + 0 }')
      echo "::notice title=Tests of shard $shard::$label $suite: $passing passing"
    fi
  done
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

run_image() {
  local image=$1 label=${1//[^a-zA-Z0-9]/-} url
  local name="$prefix-$label-$$"
  echo "$name" >>"$logs/containers"
  if ! url=$(start_server "$image" "$name" 2>"$logs/$label.server.log"); then
    echo "$label.server" >>"$logs/failed"
    return
  fi
  run_suites "$url" "$label"
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
  rm -rf "$logs"
  exit "$status"
}
trap 'finish 130' INT
trap 'finish 143' TERM
trap 'finish 129' HUP

if [[ -n "${MYSQL_TEST_URL:-}" ]]; then
  ((shard_index == 0)) && run_suites "$MYSQL_TEST_URL" server
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
