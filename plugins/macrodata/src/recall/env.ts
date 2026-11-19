/**
 * Environment-knob parsing shared by the recall hook, worker and waiter. Kept
 * free of model and index imports so a lightweight process can read the same
 * knobs the worker does.
 */

// All env knobs parse through here: bare Number("") is 0 and Number("typo") is
// NaN, and a NaN pool size makes mmrSelect return [] on every query — ambient
// recall dying silently in the long-lived worker with nothing in the logs.
// Out-of-range values keep the default and squeak per read (squeaky-gate: a
// misconfiguration should announce itself until fixed, not degrade quietly).
export function envNum(name: string, fallback: number, min: number, max = Infinity): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  // A ceiling matters for the same reason the floor does: these knobs feed
  // setTimeout and unbounded allocations, where an absurd value fails in a way
  // that looks nothing like a bad setting — a timer that overflows fires
  // immediately, a pool of a million candidates reranks until the deadline. An
  // out-of-range value is rejected rather than clamped so the warn names the
  // real setting instead of silently running something the operator never asked
  // for.
  if (!Number.isFinite(n) || n < min || n > max) {
    const range = max === Infinity ? `>= ${min}` : `between ${min} and ${max}`;
    console.warn(
      `[recall] ${name}="${raw}" invalid (need a finite number ${range}); using ${fallback}`,
    );
    return fallback;
  }
  return n;
}
