// backend/demo-feed.js
// Builds a fake Canvas feed for demos from test/sample-canvas.ics, moved forward
// by whole weeks so the items always land in the current week and the next two.
import ICAL from 'ical.js';
import { readFileSync } from 'node:fs';

const SAMPLE = readFileSync(new URL('../test/sample-canvas.ics', import.meta.url), 'utf8');
const SAMPLE_MONDAY = new Date(2026, 10, 9); // the sample's dates start the week of Mon Nov 9, 2026

function mondayOf(d) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

export function demoFeed(now = new Date()) {
  const weeks = Math.round((mondayOf(now) - SAMPLE_MONDAY) / (7 * 864e5));
  const shift = ICAL.Duration.fromData({ weeks: Math.abs(weeks), isNegative: weeks < 0 });

  const root = new ICAL.Component(ICAL.parse(SAMPLE));
  for (const vevent of root.getAllSubcomponents('vevent')) {
    for (const name of ['dtstart', 'dtend', 'recurrence-id']) {
      const prop = vevent.getFirstProperty(name);
      if (!prop) continue;
      const t = prop.getFirstValue().clone();
      t.addDuration(shift);
      prop.setValue(t);
    }
  }
  return root.toString();
}
