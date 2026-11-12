/**
 * Runs a scenario under every order of its steps that differs in an outcome, depth first, with
 * dynamic partial-order reduction and sleep sets (Flanagan and Godefroid, POPL 2005). A step is
 * one statement the fake server runs, a writer's statement, the start of a feed, or a wake of the
 * feed. Once Node has nothing else to run, the explorer releases one enabled step, and Node runs
 * the code it unblocks up to that code's next step. A step whose lock another transaction holds is
 * not enabled, as a statement waiting on a lock does not run.
 *
 * Each step names what it reads and writes. Two steps of different actors where one writes what
 * the other touches are dependent; any other two commute. After a run, every dependent pair not
 * already ordered by the steps between them marks the earlier point for another order that runs
 * the later actor first, and an order that only swaps commuting steps is never run. An order is
 * the list of picks, so a failing order replays exactly.
 */

/** What a step reads and writes, by resource name. */
export interface Footprint {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
}

/** One step an actor waits on. */
export interface Step {
  /** The actor and how many steps it took before this one: the same step in every replay. */
  readonly id: string;
  /** The actor in program order: a feed's open and polls are one actor. */
  readonly actor: string;
  readonly label: string;
  /** Whether the step can run now: false while it waits on a lock. */
  enabled(): boolean;
  footprint(): Footprint;
  /** Runs the step and releases the code that waits on it. */
  run(): void;
}

interface Option {
  readonly id: string;
  readonly actor: string;
}

/** A point of an order: the steps it could run, what is left to try there, and the one it ran. */
interface Node {
  readonly options: readonly Option[];
  /** Steps an earlier order already covers from here. */
  readonly sleep: ReadonlySet<string>;
  /** Steps run from here by an earlier order. */
  readonly done: Set<string>;
  /** Actors to run from here before the point is finished. */
  readonly backtrack: Set<string>;
  pick: string;
}

/** What one run did at a point: the actor it ran and what that step touched. */
interface Taken {
  readonly actor: string;
  readonly footprint: Footprint;
}

/** How a drain ended: no step left, only steps that wait on a lock, an order already covered, or the step budget spent. */
export type Drained = "settled" | "blocked" | "covered" | "overrun";

/** How many orders of one scenario ran, how many the sleep sets cut short, and whether they were all of them. */
export interface Exploration {
  orders: number;
  covered: number;
  exhausted: boolean;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function dependent(a: Footprint, b: Footprint): boolean {
  const clash = (writes: readonly string[], other: Footprint) =>
    writes.some((resource) => other.reads.includes(resource) || other.writes.includes(resource));
  return clash(a.writes, b) || clash(b.writes, a);
}

/** The actor a session's steps belong to: one feed reads through several sessions in program order. */
function programOf(session: string): string {
  return session.startsWith("feed") ? "feed" : session;
}

/** One run of a scenario: it replays `plan`, then runs the first step no sleep set covers. */
export class Schedule {
  readonly nodes: Node[] = [];
  readonly taken: Taken[] = [];
  readonly trace: string[] = [];
  private readonly pending: Step[] = [];
  private readonly plan: readonly Node[];
  private readonly budget: number;
  private readonly counts = new Map<string, number>();
  private sleep: ReadonlySet<string> = new Set();

  constructor(plan: readonly Node[], budget: number) {
    this.plan = plan;
    this.budget = budget;
  }

  /** Waits until the explorer picks this step, runs `run` and answers what it answered. */
  submit<T>(session: string, label: string, enabled: () => boolean, footprint: () => Footprint, run: () => T): Promise<T> {
    const id = this.idFor(session);
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        id,
        actor: programOf(session),
        label,
        enabled,
        footprint,
        run: () => {
          try {
            resolve(run());
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  }

  private idFor(session: string): string {
    const count = this.counts.get(session) ?? 0;
    this.counts.set(session, count + 1);
    return `${session}#${count}`;
  }

  /** Releases steps, `extra` ones included, until none is enabled. */
  async drain(extra: () => readonly Step[] = () => []): Promise<Drained> {
    for (;;) {
      await settle();
      const options = [...this.pending.filter((step) => step.enabled()), ...extra()];
      if (options.length === 0) {
        return this.pending.length === 0 ? "settled" : "blocked";
      }
      if (this.nodes.length >= this.budget) {
        return "overrun";
      }
      const node = this.next(options);
      if (!node) {
        return "covered";
      }
      const step = options.find((each) => each.id === node.pick);
      if (!step) {
        throw new Error(`the replay offers no step ${node.pick}`);
      }
      const chosen = step.footprint();
      const known = [...this.pending, ...options];
      this.sleep = new Set(
        [...node.sleep, ...node.done].filter((id) => {
          const other = known.find((each) => each.id === id);
          return other !== undefined && !dependent(other.footprint(), chosen);
        }),
      );
      this.nodes.push(node);
      this.taken.push({ actor: step.actor, footprint: chosen });
      const index = this.pending.indexOf(step);
      if (index >= 0) {
        this.pending.splice(index, 1);
      }
      step.run();
    }
  }

  private next(options: readonly Step[]): Node | undefined {
    const offered = options.map((step) => ({ id: step.id, actor: step.actor }));
    const planned = this.plan[this.nodes.length];
    if (planned) {
      const then = planned.options.map((option) => option.id).join(", ");
      const now = offered.map((option) => option.id).join(", ");
      if (then !== now) {
        throw new Error(`the replay diverged at step ${this.nodes.length}: ${then} then, ${now} now`);
      }
      return planned;
    }
    const first = offered.find((option) => !this.sleep.has(option.id));
    if (!first) {
      return undefined;
    }
    return { options: offered, sleep: this.sleep, done: new Set(), backtrack: new Set([first.actor]), pick: first.id };
  }

  /** The steps still waiting, as `id: label`. */
  waiting(): string[] {
    return this.pending.map((step) => `${step.id}: ${step.label}`);
  }

  /** The picks of this order, as indexes into each point's options. */
  picks(): number[] {
    return this.nodes
      .filter((node) => node.options.length > 1)
      .map((node) => node.options.findIndex((option) => option.id === node.pick));
  }
}

/**
 * A step that waited on a lock at the point it raced could have run before the step that took the
 * lock: the latest earlier point, after the actor's own last step, where it could run gets it too.
 */
function offerEarlier(nodes: readonly Node[], actor: string, before: number, after: number): void {
  for (let m = before - 1; m > after; m -= 1) {
    const node = nodes[m];
    if (node?.options.some((option) => option.actor === actor)) {
      node.backtrack.add(actor);
      return;
    }
  }
}

/**
 * The point before step `at` must also run `actor`, or every actor it could run there when `actor`
 * could not, and then the latest earlier point where `actor` could run.
 */
function markRace(nodes: readonly Node[], actor: string, at: number, after: number): void {
  const node = nodes[at];
  const runnable = node?.options.some((option) => option.actor === actor) ?? false;
  for (const option of node?.options ?? []) {
    if (!runnable || option.actor === actor) {
      node?.backtrack.add(option.actor);
    }
  }
  if (!runnable) {
    offerEarlier(nodes, actor, at, after);
  }
}

/**
 * Marks, for each step of the run, every earlier dependent step of another actor that no step
 * between them orders before it: the point before that earlier step must also try the later actor,
 * or every actor it could run when the later one could not run there.
 */
function markRaces(nodes: readonly Node[], taken: readonly Taken[]): void {
  const clocks: Map<string, number>[] = [];
  const last = new Map<string, number>();
  taken.forEach((step, n) => {
    const own = last.get(step.actor);
    const clock = new Map(own === undefined ? [] : clocks[own]);
    let isRaced = false;
    for (let j = n - 1; j >= 0; j -= 1) {
      const earlier = taken[j];
      if (!earlier || !dependent(earlier.footprint, step.footprint)) {
        continue;
      }
      const isOrdered = (clock.get(earlier.actor) ?? -1) >= j;
      if (earlier.actor !== step.actor && !isOrdered && !isRaced) {
        isRaced = true;
        markRace(nodes, step.actor, j, own ?? -1);
      }
      for (const [actor, index] of clocks[j] ?? []) {
        clock.set(actor, Math.max(clock.get(actor) ?? -1, index));
      }
    }
    clock.set(step.actor, n);
    clocks.push(clock);
    last.set(step.actor, n);
  });
}

function nextPlan(nodes: readonly Node[]): Node[] | undefined {
  for (let depth = nodes.length - 1; depth >= 0; depth -= 1) {
    const node = nodes[depth];
    if (!node) {
      continue;
    }
    node.done.add(node.pick);
    const pick = node.options.find(
      (option) => node.backtrack.has(option.actor) && !node.done.has(option.id) && !node.sleep.has(option.id),
    );
    if (pick !== undefined) {
      node.pick = pick.id;
      return nodes.slice(0, depth + 1);
    }
  }
  return undefined;
}

/** Calls `run` once per order of a scenario that differs from every earlier one, up to `limit` orders. */
export async function exploreOrders(
  run: (schedule: Schedule) => Promise<Drained>,
  limit: number,
  budget: number,
): Promise<Exploration> {
  let plan: Node[] | undefined = [];
  let orders = 0;
  let covered = 0;
  while (plan && orders + covered < limit) {
    const schedule = new Schedule(plan, budget);
    const drained = await run(schedule);
    if (drained === "covered") {
      covered += 1;
    } else {
      orders += 1;
    }
    markRaces(schedule.nodes, schedule.taken);
    plan = nextPlan(schedule.nodes);
  }
  return { orders, covered, exhausted: plan === undefined };
}
