import { existsSync, readdirSync, readFileSync } from "node:fs";
import path, { type PlatformPath } from "node:path";

import { IsDocument, IsString } from "../../implementations/database/guards";

const TEST_FILE = /\.(test|spec)\.(js|ts)$/;

/** Every test file under `dir`, in its subdirectories too, or none when `dir` is missing. */
function Walk(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return Walk(file);
    }
    return TEST_FILE.test(entry.name) ? [file] : [];
  });
}

/** The interfaces the manifest of the package in the current directory lists in `antelopeJs.implements`. */
function ImplementedInterfaces(): string[] {
  const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
  const antelopeJs: unknown = IsDocument(manifest)
    ? manifest.antelopeJs
    : undefined;
  const names: unknown = IsDocument(antelopeJs)
    ? antelopeJs.implements
    : undefined;
  return Array.isArray(names) ? names.filter(IsString) : [];
}

/** The directory of the `package.json` of the package `name` resolves to from the current one. */
function PackageRoot(name: string): string {
  let dir = path.dirname(require.resolve(name, { paths: ["."] }));
  while (!existsSync(path.join(dir, "package.json"))) {
    dir = path.dirname(dir);
  }
  return dir;
}

/**
 * The `<unit>\t<file>` line `scripts/test.sh` deals a test file by, for a `file` named the way
 * `platform` names paths: a file directly under `dist/test` is a unit of its own, by its name, and
 * any other file belongs to the `rest` unit. The line writes the file with `/` on every platform,
 * the separator test.sh matches and Git Bash passes on to `ajs`.
 */
export function UnitLine(file: string, platform: PlatformPath): string {
  const unit =
    platform.dirname(file) === platform.join("dist", "test")
      ? platform.basename(file)
      : "rest";
  return `${unit}\t${file.split(platform.sep).join("/")}`;
}

/**
 * The lines of every test file of the package in the current directory: those of `dist/test`,
 * then the conformance files under `dist/tests` of each interface in `antelopeJs.implements`.
 */
function TestFileLines(): string[] {
  return [
    ...Walk(path.join("dist", "test")).map((file) => UnitLine(file, path)),
    ...ImplementedInterfaces().flatMap((name) =>
      Walk(path.join(PackageRoot(name), "dist", "tests")).map(
        (file) => `rest\t${file}`,
      ),
    ),
  ];
}

if (require.main === module) {
  process.stdout.write(
    TestFileLines()
      .map((line) => `${line}\n`)
      .join(""),
  );
}
