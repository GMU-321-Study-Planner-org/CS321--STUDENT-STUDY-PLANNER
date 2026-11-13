const $ = (sel) => document.querySelector(sel);
const state = { courses: [], queue: [], done: [], sessions: [], events: [], linked: false, lastSync: null, weekOffset: 0 };

/* ---------- helpers ---------- */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function say(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.dataset.error = isError;
  clearTimeout(say.timer);
  say.timer = setTimeout(() => (el.textContent = ''), 5000);
}

function dueLabel(iso) {
  const due = new Date(iso);
  const now = new Date();
  const days = Math.round((startOfDay(due) - startOfDay(now)) / 864e5);
  if (due < now) return { text: `Overdue since ${dayFmt.format(due)}`, tone: 'late' };
  if (days === 0) return { text: `Today, ${timeFmt.format(due)}`, tone: 'soon' };
  if (days === 1) return { text: `Tomorrow, ${timeFmt.format(due)}`, tone: 'soon' };
  if (days < 7) return { text: `${weekdayFmt.format(due)}, ${timeFmt.format(due)}`, tone: 'ok' };
  return { text: dayFmt.format(due), tone: 'ok' };
}

const tier = (p) => (p >= 4 ? 'high' : p === 3 ? 'mid' : 'low');

/* ---------- rendering ---------- */
function renderCourses() {
  $('#course-codes').innerHTML = state.courses.map((c) => `<option value="${esc(c.code)}">`).join('');
  $('#course-list').innerHTML =
    state.courses
      .map(
        (c) => `<li>
          <div class="course-name">${esc(c.code)}</div>
          <div class="seg" role="group" aria-label="Priority for ${esc(c.code)}">
            ${[1, 2, 3, 4, 5]
              .map((n) => `<button data-course="${c.id}" data-p="${n}" aria-pressed="${c.priority === n}">${n}</button>`)
              .join('')}
          </div>
        </li>`
      )
      .join('') || '<li class="hint">Courses show up here after you import your calendar.</li>';
}

function renderQueue() {
  const list = $('#queue-list');
  if (!state.queue.length) {
    if (!state.linked) {
      // New prominent empty state for users who haven't onboarded
      list.innerHTML = `<li class="empty empty-hero">
        <p>No assignments yet. Link your Canvas calendar to get started.</p>
        <button class="empty-state-btn" onclick="$('#link-dialog').showModal()">Get Started: Link Canvas</button>
      </li>`;
    } else {
      list.innerHTML = `<li class="empty">Nothing due. Add a task or sync Canvas again.</li>`;
    }
    return;
  }
  
  list.innerHTML = state.queue
    .map((a) => {
      const due = dueLabel(a.due_at);
      const title = a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title);
      return `<li class="task" data-tone="${due.tone}">
        <input type="checkbox" data-id="${a.id}" aria-label="Mark ${esc(a.title)} complete">
        <div><div class="task-title">${title}</div><div class="task-meta">${esc(a.course_code)}</div></div>
        <div class="task-due">${esc(due.text)}</div>
      </li>`;
    })
    .join('');
}



function renderWeek() {
  const first = startOfDay(new Date());
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7) + state.weekOffset * 7); // Monday
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(first);
    d.setDate(first.getDate() + i);
    return d;
  });

  const items = [
    ...[...state.queue, ...state.done].map((a) => ({
      kind: 'due', when: new Date(a.due_at), label: a.title, tag: a.course_code, priority: a.course_priority, done: !!a.completed,
    })),
    ...state.sessions.map((s) => ({
      kind: 'session', when: new Date(s.starts_at), label: s.topic || 'Study session', tag: `${s.course_code}, ${s.minutes} min`, priority: 0, done: false,
    })),
    ...state.events.map((e) => ({
      kind: 'event', when: new Date(e.starts_at), label: e.title,
      tag: [e.course_code, e.location].filter(Boolean).join(', '), priority: 0, done: false,
    })),
  ].sort((a, b) => a.when - b.when);

  const today = new Date().toDateString();
  $('#week-label').textContent = `${shortDate.format(days[0])} to ${shortDate.format(days[6])}`;
  $('#week-grid').innerHTML = days
    .map((d) => {
      const key = d.toDateString();
      const chips = items
        .filter((i) => i.when.toDateString() === key)
        .map(
          (i) => `<li class="chip ${i.kind}" data-p="${tier(i.priority)}" data-done="${i.done}">
            <time>${timeFmt.format(i.when)}</time><span>${esc(i.label)}</span><small>${esc(i.tag)}</small>
          </li>`
        )
        .join('');
      return `<div class="day" ${key === today ? 'aria-current="date"' : ''}>
        <h3>${weekdayFmt.format(d)} <span>${d.getDate()}</span></h3><ul>${chips}</ul>
      </div>`;
    })
    .join('');
}

function render() {
  $('#sync-btn').hidden = !state.linked;
  $('#clear-btn').hidden = !state.linked;
  $('#link-btn').textContent = state.linked ? 'Change calendar link' : 'Link Canvas calendar';
  renderCourses();
  renderQueue();
  renderWeek();
}

async function load() {
  Object.assign(state, await api('/state'));
  render();
  
  // Auto-open onboarding if no Canvas link exists and they aren't already in a dialog
  if (!state.linked && !$('#link-dialog').open && !$('#priority-dialog').open) {
    $('#link-dialog').showModal();
  }
}

/* ---------- events ---------- */
$('#course-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-course]');
  if (!btn) return;
  try {
    await api(`/courses/${btn.dataset.course}`, { method: 'PATCH', body: { priority: Number(btn.dataset.p) } });
    await load(); // the queue reorders because scores depend on course priority
  } catch (err) { say(err.message, true); }
});

$('#queue-list').addEventListener('change', async (e) => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  try {
    await api(`/assignments/${e.target.dataset.id}`, { method: 'PATCH', body: { completed: e.target.checked } });
    await load();
  } catch (err) { say(err.message, true); }
});

$('#prev-week').onclick = () => { state.weekOffset--; renderWeek(); };
$('#next-week').onclick = () => { state.weekOffset++; renderWeek(); };

$('#sync-btn').onclick = async () => {
  try {
    const r = await api('/calendar/sync', { method: 'POST' });
    say(`Synced ${r.imported} items from Canvas.`);
    await load();
  } catch (err) { say(err.message, true); }
};

$('#clear-btn').onclick = async () => {
  if (!confirm('Remove all imported Canvas assignments and events? Manual tasks will be kept.')) {
    return;
  }

  try {
    const result = await api('/calendar', { method: 'DELETE' });
    await load();
    say(`Cleared ${result.assignments} assignments and ${result.events} events.`);
  } catch (err) {
    say(err.message, true);
  }
};

$('#link-btn').onclick = () => $('#link-dialog').showModal();
$('#add-task-btn').onclick = () => $('#task-dialog').showModal();
$('#add-session-btn').onclick = () => $('#session-dialog').showModal();
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

function wireForm(selector, path, toBody, okMessage) {
  const form = $(selector);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = form.querySelector('.error');
    errorEl.hidden = true;
    try {
      const res = await api(path, { method: 'POST', body: toBody(new FormData(form)) });
      form.closest('dialog').close();
      form.reset();
      say(typeof okMessage === 'function' ? okMessage(res) : okMessage);
      await load();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// Replaces the wireForm('#link-form'...) line to handle the multi-step onboarding
const linkForm = $('#link-form');
linkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = linkForm.querySelector('.error');
  errorEl.hidden = true;
  try {
    const formData = new FormData(linkForm);
    const res = await api('/calendar/link', { method: 'POST', body: { url: formData.get('url') } });
    
    $('#link-dialog').close();
    linkForm.reset();
    
    // Load state to get the newly imported courses
    await load(); 
    
    // Copy the rendered course HTML into the dialog so they can set priorities immediately
    $('#onboarding-course-list').innerHTML = $('#course-list').innerHTML;
    $('#priority-dialog').showModal();
    
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

// Allow users to click priority buttons inside the onboarding dialog
$('#onboarding-course-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-course]');
  if (!btn) return;
  
  // ADDED: Stop the priority button from submitting the form and closing the dialog
  e.preventDefault(); 
  
  try {
    await api(`/courses/${btn.dataset.course}`, { method: 'PATCH', body: { priority: Number(btn.dataset.p) } });
    await load();
    // Refresh the dialog's course list so the pressed button updates visually
    $('#onboarding-course-list').innerHTML = $('#course-list').innerHTML;
  } catch (err) { say(err.message, true); }
});

// Close priority dialog and finish setup
$('#priority-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#priority-dialog').close();
  say("Onboarding complete! Your schedule is ready.");
});wireForm('#task-form', '/assignments',
  (f) => ({ title: f.get('title'), courseCode: f.get('course'), dueAt: new Date(f.get('due')).toISOString() }), 'Task added.');
wireForm('#session-form', '/sessions',
  (f) => ({ courseCode: f.get('course'), topic: f.get('topic'), startsAt: new Date(f.get('start')).toISOString(), minutes: Number(f.get('minutes')) }),
  'Study session added.');

load().catch((err) => say(err.message, true));
