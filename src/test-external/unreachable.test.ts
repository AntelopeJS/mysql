import { expect } from "chai";

import { type CatalogOptions, GetOptions } from "../config";
import { Connect, Read } from "../connection";
import { sql } from "../statement";
import { Info } from "../implementations/catalog";

const EXTERNAL = "external";
const WRONG_PASSWORD = "not-the-password";
const CLOSED_PORT = "1";
const NO_DATABASE = "antelopejs_missing";

interface Restorable {
  url: string;
  catalog: CatalogOptions;
}

async function Refusal<T>(work: () => PromiseLike<T>): Promise<string> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return err.message;
  }
  throw new Error("the call was expected to be refused");
}

function Altered(url: string, change: (target: URL) => void): string {
  const target = new URL(url);
  change(target);
  return target.toString();
}

describe("an external instance whose first connection fails", () => {
  let original: Restorable;

  before(() => {
    const { url, catalog } = GetOptions();
    original = { url, catalog };
  });

  after(async () => {
    await Connect({ mode: EXTERNAL, ...original });
  });

  function ConnectTo(url: string, catalog: CatalogOptions) {
    return Connect({ mode: EXTERNAL, url, catalog });
  }

  function WithWrongPassword() {
    return Altered(original.url, (target) => {
      target.password = WRONG_PASSWORD;
    });
  }

  describe("with the catalog enabled", () => {
    const ENABLED = { enabled: true };

    it("starts with a wrong password, and Info() and a query refuse with the reason", async () => {
      await ConnectTo(WithWrongPassword(), ENABLED);
      const expected =
        "not connected: wrong user or password (ER_ACCESS_DENIED_ERROR)";
      expect(await Refusal(() => Info())).to.contain(expected);
      expect(await Refusal(() => Read(sql`SELECT 1`))).to.contain(expected);
    });

    it("starts with a port nobody answers on, naming the host and port", async () => {
      const url = Altered(original.url, (target) => {
        target.port = CLOSED_PORT;
      });
      await ConnectTo(url, ENABLED);
      const { hostname } = new URL(url);
      expect(await Refusal(() => Info())).to.contain(
        `not connected: the server is not answering at ${hostname}:${CLOSED_PORT} (ECONNREFUSED)`,
      );
    });

    it("starts with a database the account may not use, as a missing one reads to it", async () => {
      const url = Altered(original.url, (target) => {
        target.pathname = `/${NO_DATABASE}`;
      });
      await ConnectTo(url, ENABLED);
      expect(await Refusal(() => Info())).to.contain(
        "not connected: the user may not use the database, or it does not exist (ER_DBACCESS_DENIED_ERROR)",
      );
    });

    it("connects again on the next construct once the URL is right", async () => {
      await ConnectTo(WithWrongPassword(), ENABLED);
      await ConnectTo(original.url, ENABLED);
      const [row] = await Read(sql`SELECT 1 AS one`);
      expect(Number(row.get("one"))).to.equal(1);
    });
  });

  it("refuses to start with the catalog disabled", async () => {
    const message = await Refusal(() =>
      ConnectTo(WithWrongPassword(), { enabled: false }),
    );
    expect(message).to.contain("Access denied");
  });

  it("refuses to start outside development when the catalog is left to follow it", async () => {
    const message = await Refusal(() => ConnectTo(WithWrongPassword(), {}));
    expect(message).to.contain("Access denied");
  });
});
