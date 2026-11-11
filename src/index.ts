import { ImplementInterface } from "@antelopejs/interface-core";

import type { Options } from "./config";
import { Connect, Disconnect } from "./connection";

export type {
  CatalogOptions,
  DialectSetting,
  MigrationMode,
  Mode,
  Options,
  PoolSettings,
} from "./config";

export async function construct(options?: Options) {
  await Connect(options);

  void ImplementInterface(
    await import("@antelopejs/interface-database/query"),
    await import("./implementations/database/query"),
  );
  void ImplementInterface(
    await import("@antelopejs/interface-database/schema"),
    await import("./implementations/database/schema"),
  );
  void ImplementInterface(
    await import("@antelopejs/interface-database-catalog"),
    await import("./implementations/catalog"),
  );
}

export async function destroy() {
  await Disconnect();
}
