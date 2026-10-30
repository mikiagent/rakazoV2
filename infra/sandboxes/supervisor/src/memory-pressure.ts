import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * How much room the machine has for another computer. `calm` starts several at once,
 * `busy` starts one at a time, `full` holds new starts until memory frees up.
 */
export type MemoryPressureLevel = "calm" | "busy" | "full";

export type MemorySample = {
  /** Share of memory in use, 0-100, counting reclaimable cache as free. */
  usedPercent: number;
  /** Linux PSI `some avg10`: share of the last 10s some task stalled on memory. */
  stallPercent?: number;
  /** macOS kernel verdict: 1 normal, 2 warn, 4 critical. */
  kernelLevel?: number;
};

export type MemoryPressureSettings = {
  busyPercent: number;
  fullPercent: number;
  maxParallelStarts: number;
  waitMs: number;
};

const DEFAULT_SETTINGS: MemoryPressureSettings = {
  busyPercent: 80,
  fullPercent: 92,
  maxParallelStarts: 4,
  waitMs: 120_000,
};
/** PSI stalls are a sharper signal than usage: the kernel is already reclaiming hard. */
const BUSY_STALL_PERCENT = 5;
const FULL_STALL_PERCENT = 20;
/** A started computer takes a few seconds to reach its working set; hold its slot until then. */
const START_SETTLE_MS = 5_000;
const POLL_MS = 1_000;

export class MemoryPressureTimeout extends Error {
  constructor(waitMs: number) {
    super(`Not enough free memory to start a computer (waited ${Math.round(waitMs / 1000)}s)`);
    this.name = "MemoryPressureTimeout";
  }
}

function percent(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(`${name} must be a percentage between 1 and 100, received "${raw}"`);
  }
  return value;
}

function nonNegativeInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, received "${raw}"`);
  }
  return value;
}

export function resolveMemoryPressureSettings(
  env: NodeJS.ProcessEnv = process.env,
): MemoryPressureSettings {
  const busyPercent = percent(
    "SANDBOX_MEMORY_BUSY_PERCENT",
    env.SANDBOX_MEMORY_BUSY_PERCENT,
    DEFAULT_SETTINGS.busyPercent,
  );
  const fullPercent = percent(
    "SANDBOX_MEMORY_FULL_PERCENT",
    env.SANDBOX_MEMORY_FULL_PERCENT,
    DEFAULT_SETTINGS.fullPercent,
  );
  if (busyPercent > fullPercent) {
    throw new Error("SANDBOX_MEMORY_BUSY_PERCENT must not exceed SANDBOX_MEMORY_FULL_PERCENT");
  }
  return {
    busyPercent,
    fullPercent,
    maxParallelStarts: nonNegativeInteger(
      "SANDBOX_MAX_PARALLEL_COMPUTER_STARTS",
      env.SANDBOX_MAX_PARALLEL_COMPUTER_STARTS,
      DEFAULT_SETTINGS.maxParallelStarts,
    ),
    waitMs: nonNegativeInteger(
      "SANDBOX_MEMORY_WAIT_MS",
      env.SANDBOX_MEMORY_WAIT_MS,
      DEFAULT_SETTINGS.waitMs,
    ),
  };
}

export function classifyMemoryPressure(
  sample: MemorySample,
  settings: Pick<MemoryPressureSettings, "busyPercent" | "fullPercent">,
): MemoryPressureLevel {
  const stall = sample.stallPercent ?? 0;
  if (
    sample.usedPercent >= settings.fullPercent ||
    stall >= FULL_STALL_PERCENT ||
    (sample.kernelLevel ?? 1) >= 4
  ) {
    return "full";
  }
  if (
    sample.usedPercent >= settings.busyPercent ||
    stall >= BUSY_STALL_PERCENT ||
    (sample.kernelLevel ?? 1) >= 2
  ) {
    return "busy";
  }
  return "calm";
}

/** Parses /proc/meminfo; MemAvailable already counts reclaimable cache as free. */
export function parseMeminfo(text: string): number | undefined {
  const field = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text);
    return match ? Number(match[1]) : undefined;
  };
  const total = field("MemTotal");
  const available = field("MemAvailable");
  if (!total || available === undefined) return undefined;
  return (1 - available / total) * 100;
}

export function parsePressureStall(text: string): number | undefined {
  const match = /^some\b.*\bavg10=(\d+(?:\.\d+)?)/m.exec(text);
  return match ? Number(match[1]) : undefined;
}

async function readLinuxSample(): Promise<MemorySample | undefined> {
  // A containerized supervisor sees the host (or Docker Desktop VM) here, which is where
  // the computers it starts draw their memory from.
  const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => undefined);
  const usedPercent = meminfo ? parseMeminfo(meminfo) : undefined;
  if (usedPercent === undefined) return undefined;
  const pressure = await readFile("/proc/pressure/memory", "utf8").catch(() => undefined);
  return { usedPercent, stallPercent: pressure ? parsePressureStall(pressure) : undefined };
}

async function readDarwinSample(): Promise<MemorySample | undefined> {
  // memorystatus_level is the "free percentage" `memory_pressure` reports, so compressed and
  // purgeable pages count as reclaimable; os.freemem() alone would read a healthy Mac as full.
  const { stdout } = await execFileAsync(
    "sysctl",
    ["-n", "kern.memorystatus_level", "kern.memorystatus_vm_pressure_level"],
    { timeout: 2_000 },
  ).catch(() => ({ stdout: "" }));
  const [free, level] = stdout.trim().split(/\s+/).map(Number);
  if (free === undefined || !Number.isFinite(free)) return undefined;
  return { usedPercent: 100 - free, kernelLevel: Number.isFinite(level) ? level : undefined };
}

export async function readMemorySample(platform = process.platform): Promise<MemorySample> {
  const sample =
    platform === "linux"
      ? await readLinuxSample()
      : platform === "darwin"
        ? await readDarwinSample()
        : undefined;
  return sample ?? { usedPercent: (1 - freemem() / totalmem()) * 100 };
}

type Waiter = { resolve: () => void; reject: (error: unknown) => void };

/**
 * Admits computer starts by the machine's memory pressure: several at once while memory is
 * calm, one at a time when it is busy, and none while it is full, queuing the rest in
 * arrival order until memory frees up or `waitMs` passes. Only starts wait; running
 * computers, commands and screens are never gated.
 */
export class MemoryPressureGate {
  private active = 0;
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private level: MemoryPressureLevel = "calm";

  constructor(
    private readonly settings: MemoryPressureSettings,
    private readonly read: () => Promise<MemorySample> = readMemorySample,
    private readonly onLevel?: (level: MemoryPressureLevel, sample: MemorySample) => void,
  ) {}

  /**
   * Waits until memory allows another start. Call the returned release once the start is
   * done; the slot stays held a few seconds more so the next reading includes the new computer.
   */
  async admit(signal?: AbortSignal): Promise<() => void> {
    await this.acquire(signal);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setTimeout(() => this.release(), START_SETTLE_MS).unref?.();
    };
  }

  private limit(): number {
    if (this.level === "full") return 0;
    if (this.level === "busy") return 1;
    return this.settings.maxParallelStarts || Number.POSITIVE_INFINITY;
  }

  private async refresh() {
    const sample = await this.read().catch(() => undefined);
    // An unreadable sample never blocks starts.
    const level = sample ? classifyMemoryPressure(sample, this.settings) : "calm";
    if (level !== this.level && sample) this.onLevel?.(level, sample);
    this.level = level;
  }

  private async acquire(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.queue.length === 0) {
      await this.refresh();
      // The request may have been cancelled while memory was read.
      signal?.throwIfAborted();
      if (this.active < this.limit()) {
        this.active++;
        return;
      }
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const leave = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const timeout = setTimeout(() => {
        leave();
        waiter.reject(new MemoryPressureTimeout(this.settings.waitMs));
      }, this.settings.waitMs);
      const abort = () => {
        leave();
        waiter.reject(signal?.reason);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(waiter);
      this.schedule(0);
    });
  }

  private release() {
    this.active--;
    this.schedule(0);
  }

  private schedule(delayMs: number) {
    if (this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delayMs);
  }

  private async drain() {
    await this.refresh();
    while (this.queue.length > 0 && this.active < this.limit()) {
      this.active++;
      this.queue.shift()?.resolve();
    }
    // Memory is read again on a short poll while anything waits, since it frees up on its
    // own as pages are reclaimed or other processes exit, not only when a start finishes.
    this.schedule(POLL_MS);
  }
}
