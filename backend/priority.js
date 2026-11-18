// Binary min-heap: the smallest score (most urgent) comes out first.
class MinHeap {
  #a = [];
  get size() { return this.#a.length; }

  push(item, score) {
    this.#a.push({ item, score });
    let i = this.#a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.#a[p].score <= this.#a[i].score) break;
      [this.#a[p], this.#a[i]] = [this.#a[i], this.#a[p]];
      i = p;
    }
  }

  pop() {
    const top = this.#a[0];
    const last = this.#a.pop();
    if (this.#a.length) {
      this.#a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.#a.length && this.#a[l].score < this.#a[m].score) m = l;
        if (r < this.#a.length && this.#a[r].score < this.#a[m].score) m = r;
        if (m === i) break;
        [this.#a[m], this.#a[i]] = [this.#a[i], this.#a[m]];
        i = m;
      }
    }
    return top.item;
  }
}

// Score = hours until due, divided by the course priority (1-5).
// A priority-5 course feels twice as urgent as priority-2.5. Overdue work always sorts first.
export function scoreOf(row, now = Date.now()) {
  const hours = (new Date(row.due_at).getTime() - now) / 36e5;
  return hours < 0 ? hours : hours / (row.course_priority || 3);
}

export function rankAssignments(rows) {
  const heap = new MinHeap();
  const now = Date.now();
  for (const row of rows) if (!row.completed) heap.push(row, scoreOf(row, now));
  const ranked = [];
  while (heap.size) ranked.push(heap.pop());
  return ranked;
}
