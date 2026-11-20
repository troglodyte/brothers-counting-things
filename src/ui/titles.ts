// Titles the user has named, each with a few looks (see algorithm/appearance),
// so the next photo of the same title gets its name filled in. Kept apart from
// the counted list: clearing the list must not forget the titles.

import { lookSimilarity } from '../algorithm/appearance';

interface Title {
  name: string;
  looks: number[][];
}

const KEY = 'stack-counter.titles.v1';
const LOOKS_PER_TITLE = 8;
/** Same stack from another angle scores ~0.98; different titles 0.67 at most. */
const MATCH_AT = 0.85;
/** The runner-up title must be clearly worse, or it's a guess. */
const MARGIN = 0.08;

export class Titles {
  private titles: Title[] = [];

  constructor() {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      if (Array.isArray(parsed)) this.titles = parsed as Title[];
    } catch {
      this.titles = [];
    }
  }

  names(): string[] {
    return this.titles.map((t) => t.name);
  }

  /** The title this look belongs to, or null if none is a confident match. */
  match(look: Float32Array): { name: string; score: number } | null {
    const scored = this.titles
      .map((t) => ({ name: t.name, score: Math.max(0, ...t.looks.map((l) => lookSimilarity(look, l))) }))
      .sort((a, b) => b.score - a.score);
    const [best, next] = scored;
    if (!best || best.score < MATCH_AT) return null;
    if (next && best.score - next.score < MARGIN) return null;
    return best;
  }

  /** Remember this look under this name (newest kept, oldest dropped). */
  learn(name: string, look: Float32Array): void {
    const key = name.trim().toLowerCase();
    let t = this.titles.find((x) => x.name.toLowerCase() === key);
    if (!t) {
      t = { name: name.trim(), looks: [] };
      this.titles.push(t);
    }
    t.looks.push(Array.from(look, (v) => Math.round(v * 1e4) / 1e4));
    if (t.looks.length > LOOKS_PER_TITLE) t.looks.shift();
    try {
      localStorage.setItem(KEY, JSON.stringify(this.titles));
    } catch {
      // Storage full or blocked: recognition just won't persist.
    }
  }
}
