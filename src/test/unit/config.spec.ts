import { expect } from "chai";

import {
  type ForeignValue,
  Untyped,
  WithOptions,
  WithoutOptions,
} from "./spec-fixture";
import { GetOptions, type Options, SetOptions } from "../../config";

const VALIDATED = [
  "cursorBatchSize",
  "cursorIdleTimeoutMs",
  "maxOpenCursors",
  "changeRetentionMs",
  "changeBatchSize",
  "changePollIntervalMs",
] as const;

type ValidatedOption = (typeof VALIDATED)[number];

const DEFAULTS: Record<ValidatedOption, number> = {
  cursorBatchSize: 100,
  cursorIdleTimeoutMs: 60_000,
  maxOpenCursors: 5,
  changeRetentionMs: 300_000,
  changeBatchSize: 256,
  changePollIntervalMs: 100,
};

const REFUSED_NUMBERS: readonly number[] = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
  1e21,
];

const REFUSED_NON_NUMBERS: readonly ForeignValue[] = ["100", null, {}];

const EXTERNAL_REFUSED: readonly Options[] = [
  { schemaPrefix: "app_" },
  { migrations: "safe" },
  { changeRetentionMs: 1000 },
  { changeBatchSize: 10 },
  { changePollIntervalMs: 1000 },
];

function Setting(option: ValidatedOption, value: number): Options {
  const options: Options = {};
  options[option] = value;
  return options;
}

describe("SetOptions on integer options", () => {
  for (const option of VALIDATED) {
    it(`accepts a positive integer ${option}`, () => {
      WithOptions(Setting(option, 7), () => {
        expect(GetOptions()[option]).to.equal(7);
      });
    });

    it(`defaults ${option} when it is omitted`, () => {
      WithOptions({}, () => {
        expect(GetOptions()[option]).to.equal(DEFAULTS[option]);
      });
    });

    it(`refuses a ${option} that is not a positive safe integer, naming it`, () => {
      for (const value of REFUSED_NUMBERS) {
        const options = Untyped(option, value);
        expect(() => SetOptions(options)).to.throw(option);
        expect(() => SetOptions(options)).to.throw(String(value));
      }
      for (const value of REFUSED_NON_NUMBERS) {
        expect(() => SetOptions(Untyped(option, value))).to.throw(option);
      }
    });
  }

  it("accepts a statementTimeoutMs of 0, which leaves reads unbounded, and refuses a negative one", () => {
    WithOptions({ statementTimeoutMs: 0 }, () => {
      expect(GetOptions().statementTimeoutMs).to.equal(0);
    });
    expect(() => SetOptions({ statementTimeoutMs: -1 })).to.throw(
      /statementTimeoutMs must be a non-negative safe integer/,
    );
    expect(() => SetOptions(Untyped("statementTimeoutMs", "5"))).to.throw(
      /statementTimeoutMs/,
    );
  });

  it("defaults maxOpenCursors to half of pool.connectionLimit, and to one at the least", () => {
    const defaults = [
      [1, 1],
      [2, 1],
      [4, 2],
      [7, 3],
      [100, 50],
    ] as const;
    for (const [connectionLimit, expected] of defaults) {
      WithOptions({ pool: { connectionLimit } }, () => {
        expect(GetOptions().maxOpenCursors).to.equal(expected);
      });
    }
  });

  it("keeps a maxOpenCursors that is given, whatever the pool holds", () => {
    WithOptions({ maxOpenCursors: 9, pool: { connectionLimit: 4 } }, () => {
      expect(GetOptions().maxOpenCursors).to.equal(9);
    });
  });

  it("leaves the configuration in place when it refuses", () => {
    WithOptions({ cursorBatchSize: 7 }, () => {
      expect(() => SetOptions({ cursorBatchSize: 0 })).to.throw();
      expect(GetOptions().cursorBatchSize).to.equal(7);
    });
  });
});

describe("SetOptions on the other options", () => {
  it("resolves the options the integer validation does not touch", () => {
    WithOptions(
      {
        url: "mysql://someone@elsewhere:3306/other",
        schemaPrefix: "app_",
        migrations: "destructive",
        pool: { connectionLimit: 4 },
        dialect: "mysql",
      },
      () => {
        const options = GetOptions();
        expect(options.url).to.equal("mysql://someone@elsewhere:3306/other");
        expect(options.schemaPrefix).to.equal("app_");
        expect(options.migrations).to.equal("destructive");
        expect(options.pool).to.deep.equal({ connectionLimit: 4 });
        expect(options.dialect).to.equal("mysql");
      },
    );
  });

  it("detects the dialect when none is named", () => {
    WithOptions({}, () => {
      expect(GetOptions().dialect).to.equal("auto");
    });
  });

  it("refuses a dialect it has no entry for, naming it", () => {
    expect(() => SetOptions(Untyped("dialect", "oracle"))).to.throw("oracle");
    expect(() => SetOptions(Untyped("dialect", "toString"))).to.throw(
      "toString",
    );
  });

  it("refuses a pool option the module sets itself, naming each", () => {
    expect(() => SetOptions({ pool: Untyped("jsonStrings", false) })).to.throw(
      "pool.jsonStrings",
    );
    expect(() => SetOptions({ pool: Untyped("uri", "mysql://x/y") })).to.throw(
      "pool.uri",
    );
    expect(() =>
      SetOptions({ pool: Untyped("resetOnRelease", true) }),
    ).to.throw("pool.resetOnRelease");
  });

  it("serves owned tables when no mode is given", () => {
    WithOptions({}, () => {
      expect(GetOptions().mode).to.equal("owned");
    });
  });

  it("refuses a mode it does not know", () => {
    expect(() => SetOptions(Untyped("mode", "readonly"))).to.throw("readonly");
  });

  for (const refused of EXTERNAL_REFUSED) {
    const [option] = Object.keys(refused);
    it(`refuses ${option} in external mode, naming it`, () => {
      expect(() => SetOptions({ ...refused, mode: "external" })).to.throw(
        option,
      );
    });
  }

  it("refuses external mode without a url, naming the option", () => {
    expect(() => SetOptions({ mode: "external" })).to.throw("config.url");
  });

  it("refuses external mode with a blank url, as an unset variable in .env leaves it", () => {
    expect(() => SetOptions({ mode: "external", url: "" })).to.throw(
      "config.url",
    );
    expect(() => SetOptions({ mode: "external", url: "  " })).to.throw(
      "config.url",
    );
  });

  it("falls back to the default url in owned mode", () => {
    WithOptions({}, () => {
      expect(GetOptions().url).to.equal(
        "mysql://root@localhost:3306/antelopejs",
      );
    });
  });

  it("accepts an external mode with only the options that apply to it", () => {
    WithOptions(
      {
        mode: "external",
        url: "mysql://reader@client/erp",
        statementTimeoutMs: 5000,
      },
      () => {
        expect(GetOptions().mode).to.equal("external");
      },
    );
  });
});

describe("GetOptions with no configuration set", () => {
  it("names either engine, since no dialect is configured", () => {
    expect(() => WithoutOptions(() => GetOptions())).to.throw(
      "MySQL or MariaDB adapter is not configured: construct() has not run yet",
    );
  });
});
