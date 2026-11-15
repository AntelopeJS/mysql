import { expect } from "chai";
import { createConnection } from "mysql2/promise";

import { GetOptions } from "../config";
import { probe } from "../probe";
import {
  NthCommand,
  PREPARE_COMMAND,
  RefuseNthPrepare,
  QUERY_COMMAND,
  Relay,
  TIMEOUT_MS,
  Unaborted,
} from "./unit/probe-fixture";

/** A database of one table, so the probe confirms a relation. */
const DATABASE = "probe_steps";

/** `ER_MAX_PREPARED_STMT_COUNT_REACHED`: the server's cap on prepared statements, whatever the account may do. */
const MAX_PREPARED_STATEMENTS = 1461;

/** How long the relay holds each chunk from the server, so a round trip takes at least that. */
const DELAY_MS = 100;

/** Each step the probe takes after the sign-in, by the command that starts it. */
const STEPS = [
  ["the account's query", QUERY_COMMAND, 1],
  ["the session pin", QUERY_COMMAND, 2],
  ["the lock wait bound", QUERY_COMMAND, 3],
  ["the listing", PREPARE_COMMAND, 1],
  ["the first relation confirmed", PREPARE_COMMAND, 2],
] as const;

describe("probe, at each step of a live server", function () {
  this.timeout(60_000);
  const admin = new URL(GetOptions().url ?? "");
  const host = admin.hostname;
  const port = Number(admin.port || 3306);

  function Through(relayPort: number): string {
    const url = new URL(admin);
    url.port = String(relayPort);
    url.pathname = `/${DATABASE}`;
    return url.toString();
  }

  async function AsAdmin(statements: readonly string[]): Promise<void> {
    const connection = await createConnection(admin.toString());
    try {
      for (const statement of statements) {
        await connection.query(statement);
      }
    } finally {
      await connection.end();
    }
  }

  before(() =>
    AsAdmin([
      `DROP DATABASE IF EXISTS ${DATABASE}`,
      `CREATE DATABASE ${DATABASE}`,
      `CREATE TABLE ${DATABASE}.t (id INT PRIMARY KEY)`,
    ]),
  );
  after(() => AsAdmin([`DROP DATABASE IF EXISTS ${DATABASE}`]));

  for (const [step, command, nth] of STEPS) {
    for (const behaviour of ["stall", "cut"] as const) {
      /** Fails on a probe that leaves a step unbounded, keeps its socket once no server answers, or calls a lost server a refusal. */
      it(`answers unreachable within the timeout, and shuts its socket at once, when the server ${behaviour === "stall" ? "stops answering" : "drops the connection"} at ${step}`, async () => {
        const relay = await Relay(host, port, {
          [behaviour]: NthCommand(command, nth),
        });
        try {
          const started = performance.now();
          const answer = await probe({
            url: Through(relay.port),
            timeoutMs: TIMEOUT_MS,
            signal: Unaborted(),
          });
          expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS * 2);
          expect(answer.outcome).to.equal("unreachable");
          expect(await relay.openAfter(TIMEOUT_MS / 2)).to.equal(0);
        } finally {
          await relay.close();
        }
      });
    }
  }

  /** Fails on a probe that reads a server that cannot take up a relation's check as an account without the privilege. */
  it("answers that it cannot list the relations when the server cannot take up a relation's check", async () => {
    const relay = await Relay(host, port, {
      answer: RefuseNthPrepare(
        2,
        MAX_PREPARED_STATEMENTS,
        "Can't create more than max_prepared_stmt_count statements",
      ),
    });
    try {
      const answer = await probe({
        url: Through(relay.port),
        timeoutMs: TIMEOUT_MS,
        signal: Unaborted(),
      });
      expect(answer).to.deep.include({
        outcome: "signed-in",
        canRead: false,
        canWrite: false,
        unreadable: "cannot-list",
      });
    } finally {
      await relay.close();
    }
  });

  /** Fails on a probe whose latency counts more than one round trip of its first query. */
  it("answers the first query's single round trip as the latency", async () => {
    const relay = await Relay(host, port, { delayMs: DELAY_MS });
    try {
      const answer = await probe({
        url: Through(relay.port),
        timeoutMs: TIMEOUT_MS * 5,
        signal: Unaborted(),
      });
      expect(answer)
        .to.have.property("latencyMs")
        .that.is.at.least(DELAY_MS)
        .and.below(DELAY_MS * 2);
    } finally {
      await relay.close();
    }
  });
});
