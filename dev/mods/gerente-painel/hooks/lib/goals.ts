export type QueueItem = {
  id: string;
  title: string;
  kind: 'executable' | 'owner';
  tier: string | null;
  gate: string | null;
  plan: string | null;
};

const ITEM = /^- \[ \] \*\*(G[0-9]+\.[0-9]+) (.+?)\*\*/;
const MAX_TITLE = 60;

function cut(title: string): string {
  const chars = Array.from(title);
  return chars.length > MAX_TITLE ? chars.slice(0, MAX_TITLE - 1).join('') + '…' : title;
}

export function parseGoals(text: string): QueueItem[] {
  const items: QueueItem[] = [];
  let plan: string | null = null;
  let owner = false;
  let current: QueueItem | null = null;
  let manual = false;

  const close = () => {
    if (current) {
      const tierUser = current.tier !== null && current.tier.startsWith('user');
      current.kind = tierUser || manual || owner ? 'owner' : 'executable';
      items.push(current);
    }
    current = null;
    manual = false;
  };

  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6} /.test(line)) {
      close();
      const heading = /^## GOALS ([0-9]+)\b/.exec(line);
      owner = /^## Owner backlog\b/.test(line);
      plan = heading?.[1] ?? null;
      continue;
    }
    if (/^- /.test(line)) {
      close();
      const m = ITEM.exec(line);
      if (m) {
        const raw = (m[2] ?? '').replace(/\s*\(GOALS [0-9]+\)\s*$/, '').trim();
        manual = raw.includes('[MANUAL');
        current = { id: m[1] ?? '', title: cut(raw), kind: 'executable', tier: null, gate: null, plan };
      }
      continue;
    }
    if (current) {
      const t = /^ {2}- tier:\s*(.*?)\s*$/.exec(line);
      if (t) current.tier = t[1] || null;
      const g = /^ {2}- gate:\s*(.*?)\s*$/.exec(line);
      if (g) current.gate = g[1] || null;
    }
  }
  close();
  return items;
}
