import { describe, expect, it } from "vitest";
import { installStopHandler } from "../../src/engine/stop.js";

function fakeProc() {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  const proc = {
    on: (ev: string, fn: () => void) => {
      listeners.set(ev, fn);
      return proc;
    },
    off: (ev: string) => {
      listeners.delete(ev);
      return proc;
    },
    exit: (code?: number) => {
      exits.push(code ?? 0);
    },
  };
  return {
    proc: proc as unknown as Pick<NodeJS.Process, "on" | "off" | "exit">,
    fire: (sig = "SIGINT") => listeners.get(sig)?.(),
    exits,
    listeners,
  };
}

describe("installStopHandler", () => {
  it("1er Ctrl+C : arrêt après la phase ; 2e : arrêt immédiat de la session puis sortie différée ; 3e : sortie", () => {
    const f = fakeProc();
    const timers: { fn: () => void; ms: number }[] = [];
    let killed = 0;
    const stop = installStopHandler(f.proc, {
      write: () => undefined,
      killChildren: () => {
        killed += 1;
      },
      graceMs: 5_000,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return {};
      },
    });
    f.fire();
    expect(stop.signal.aborted).toBe(true);
    expect(stop.immediateSignal.aborted).toBe(false);
    expect(f.exits).toEqual([]);

    f.fire();
    expect(stop.immediateSignal.aborted).toBe(true);
    expect(f.exits).toEqual([]); // pas de sortie brutale : la session interrompue laisse l'état propre
    expect(timers.map((t) => t.ms)).toEqual([5_000]);
    timers[0]!.fn();
    expect(f.exits).toEqual([130]);
    expect(killed).toBe(1); // processus détachés tués avant la sortie

    f.fire();
    expect(f.exits).toEqual([130, 130]);
    expect(killed).toBe(2);

    stop.dispose();
    expect(f.listeners.size).toBe(0);
  });

  it("SIGHUP : arrêt immédiat (sessions interrompues, état conservé), processus enfants tués puis sortie", () => {
    const f = fakeProc();
    const timers: { fn: () => void; ms: number }[] = [];
    const written: string[] = [];
    const order: string[] = [];
    const stop = installStopHandler(
      { ...f.proc, exit: ((code?: number) => { order.push(`exit:${code}`); f.proc.exit(code); }) as never },
      {
        write: (m) => written.push(m),
        killChildren: () => order.push("kill"),
        graceMs: 3_000,
        setTimer: (fn, ms) => {
          timers.push({ fn, ms });
          return {};
        },
      },
    );
    f.fire("SIGHUP");
    expect(stop.signal.aborted).toBe(true);
    expect(stop.immediateSignal.aborted).toBe(true);
    expect(written).toEqual([]); // terminal fermé : rien n'y est écrit
    expect(f.exits).toEqual([]);
    expect(timers.map((t) => t.ms)).toEqual([3_000]);
    timers[0]!.fn();
    expect(order).toEqual(["kill", "exit:129"]);
    stop.dispose();
    expect(f.listeners.size).toBe(0);
  });

  it("SIGTERM : arrêt immédiat dès le premier signal ; un second fait sortir tout de suite", () => {
    const f = fakeProc();
    let killed = 0;
    const stop = installStopHandler(f.proc, {
      write: () => undefined,
      killChildren: () => {
        killed += 1;
      },
      setTimer: () => ({}),
    });
    f.fire("SIGTERM");
    expect(stop.immediateSignal.aborted).toBe(true);
    expect(f.exits).toEqual([]);
    f.fire("SIGTERM");
    expect(f.exits).toEqual([143]);
    expect(killed).toBe(1);
    stop.dispose();
  });

  it("une écriture impossible sur le terminal n'empêche pas l'arrêt", () => {
    const f = fakeProc();
    const stop = installStopHandler(f.proc, {
      write: () => {
        throw new Error("EIO");
      },
      killChildren: () => undefined,
      setTimer: () => ({}),
    });
    f.fire("SIGTERM");
    expect(stop.immediateSignal.aborted).toBe(true);
    stop.dispose();
  });
});
