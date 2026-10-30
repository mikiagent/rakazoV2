import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemorySample } from "./memory-pressure.js";
import {
  classifyMemoryPressure,
  MemoryPressureGate,
  MemoryPressureTimeout,
  parseMeminfo,
  parsePressureStall,
  resolveMemoryPressureSettings,
} from "./memory-pressure.js";

const settings = { busyPercent: 80, fullPercent: 92, maxParallelStarts: 2, waitMs: 30_000 };

describe("classifyMemoryPressure", () => {
  it("grades usage, PSI stalls and the macOS kernel level", () => {
    expect(classifyMemoryPressure({ usedPercent: 50 }, settings)).toBe("calm");
    expect(classifyMemoryPressure({ usedPercent: 85 }, settings)).toBe("busy");
    expect(classifyMemoryPressure({ usedPercent: 95 }, settings)).toBe("full");
    expect(classifyMemoryPressure({ usedPercent: 50, stallPercent: 6 }, settings)).toBe("busy");
    expect(classifyMemoryPressure({ usedPercent: 50, stallPercent: 25 }, settings)).toBe("full");
    expect(classifyMemoryPressure({ usedPercent: 50, kernelLevel: 2 }, settings)).toBe("busy");
    expect(classifyMemoryPressure({ usedPercent: 50, kernelLevel: 4 }, settings)).toBe("full");
  });
});

describe("memory readers", () => {
  it("counts MemAvailable as free", () => {
    const used = parseMeminfo("MemTotal:  1000 kB\nMemFree:  100 kB\nMemAvailable:  600 kB\n");
    expect(used).toBeCloseTo(40);
    expect(parseMeminfo("MemTotal: 1000 kB\n")).toBeUndefined();
  });

  it("reads the PSI some avg10 line", () => {
    const text =
      "some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=4.00 avg60=1.00 avg300=0.00 total=1\n";
    expect(parsePressureStall(text)).toBe(12.5);
  });
});

describe("resolveMemoryPressureSettings", () => {
  it("uses defaults and rejects malformed values", () => {
    expect(resolveMemoryPressureSettings({})).toEqual({
      busyPercent: 80,
      fullPercent: 92,
      maxParallelStarts: 4,
      waitMs: 120_000,
    });
    expect(() => resolveMemoryPressureSettings({ SANDBOX_MEMORY_FULL_PERCENT: "120" })).toThrow(
      /SANDBOX_MEMORY_FULL_PERCENT/,
    );
    expect(() =>
      resolveMemoryPressureSettings({
        SANDBOX_MEMORY_BUSY_PERCENT: "95",
        SANDBOX_MEMORY_FULL_PERCENT: "90",
      }),
    ).toThrow(/must not exceed/);
    expect(() =>
      resolveMemoryPressureSettings({ SANDBOX_MAX_PARALLEL_COMPUTER_STARTS: "-1" }),
    ).toThrow(/SANDBOX_MAX_PARALLEL_COMPUTER_STARTS/);
  });
});

describe("MemoryPressureGate", () => {
  let sample: MemorySample;
  const read = async () => sample;

  beforeEach(() => {
    vi.useFakeTimers();
    sample = { usedPercent: 40 };
  });
  afterEach(() => vi.useRealTimers());

  async function admitted(promises: Promise<unknown>[]) {
    let count = 0;
    for (const promise of promises) {
      promise.then(
        () => {
          count++;
        },
        () => undefined,
      );
    }
    await vi.advanceTimersByTimeAsync(0);
    return count;
  }

  it("starts several at once while memory is calm, up to the cap", async () => {
    const gate = new MemoryPressureGate(settings, read);
    const starts = [gate.admit(), gate.admit(), gate.admit()];
    expect(await admitted(starts)).toBe(2);

    const release = await starts[0];
    release?.();
    // The slot is held while the new computer settles.
    expect(await admitted([starts[2] as Promise<unknown>])).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await admitted([starts[2] as Promise<unknown>])).toBe(1);
  });

  it("starts one at a time when memory is busy", async () => {
    sample = { usedPercent: 85 };
    const gate = new MemoryPressureGate(settings, read);
    expect(await admitted([gate.admit(), gate.admit()])).toBe(1);
  });

  it("queues while memory is full and starts once it frees up", async () => {
    sample = { usedPercent: 96 };
    const gate = new MemoryPressureGate(settings, read);
    const start = gate.admit();
    expect(await admitted([start])).toBe(0);
    sample = { usedPercent: 60 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await admitted([start])).toBe(1);
  });

  it("gives up after the wait limit", async () => {
    sample = { usedPercent: 96 };
    const gate = new MemoryPressureGate(settings, read);
    const start = gate.admit();
    const outcome = expect(start).rejects.toBeInstanceOf(MemoryPressureTimeout);
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
  });

  it("drops a waiting start when its request is cancelled", async () => {
    sample = { usedPercent: 96 };
    const gate = new MemoryPressureGate(settings, read);
    const controller = new AbortController();
    const start = gate.admit(controller.signal);
    const outcome = expect(start).rejects.toThrow();
    controller.abort();
    await outcome;
    sample = { usedPercent: 40 };
    expect(await admitted([gate.admit(), gate.admit()])).toBe(2);
  });

  it("never blocks when memory cannot be read", async () => {
    const gate = new MemoryPressureGate(settings, async () => {
      throw new Error("unreadable");
    });
    expect(await admitted([gate.admit()])).toBe(1);
  });
});
