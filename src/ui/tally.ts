// The running list of counted stacks. Kept in localStorage so a reload or a
// killed tab doesn't lose a stocktake halfway through; if storage is
// unavailable it simply lives for the session.

import type { Confidence } from '../algorithm/count';

export interface TallyEntry {
  name: string;
  count: number;
  confidence: Confidence;
  at: number;
}

const KEY = 'stack-counter.tally.v1';
const CONFIDENCES: readonly string[] = ['good', 'check', 'low'];

/** Saved entries that still make sense; anything damaged is dropped, not trusted. */
export function parseEntries(raw: unknown): TallyEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e): TallyEntry[] => {
    if (typeof e !== 'object' || e === null) return [];
    const { name, count, confidence, at } = e as Record<string, unknown>;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return [];
    return [
      {
        name: typeof name === 'string' ? name : '',
        count,
        confidence: typeof confidence === 'string' && CONFIDENCES.includes(confidence) ? (confidence as Confidence) : 'low',
        at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
      },
    ];
  });
}

export class Tally {
  entries: TallyEntry[] = [];

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      this.entries = parseEntries(parsed);
    } catch {
      this.entries = [];
    }
  }

  add(e: TallyEntry): void {
    this.entries.push(e);
    this.save();
  }

  remove(i: number): void {
    this.entries.splice(i, 1);
    this.save();
  }

  clear(): void {
    this.entries = [];
    this.save();
  }

  get total(): number {
    return this.entries.reduce((s, e) => s + e.count, 0);
  }

  /** Tab-separated, one stack per line: pastes into a spreadsheet or a message. */
  toText(): string {
    const lines = this.entries.map((e, i) => `${e.name || `Stack ${i + 1}`}\t${e.count}${e.confidence === 'good' ? '' : ' (check)'}`);
    lines.push(`Total\t${this.total}`);
    return lines.join('\n');
  }

  /** Names typed so far, most recent first, for the name suggestions. */
  names(): string[] {
    return [...new Set(this.entries.map((e) => e.name).filter(Boolean).reverse())];
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.entries));
    } catch {
      // Private mode or full storage: keep the in-memory list.
    }
  }
}
