const $ = (sel) => document.querySelector(sel);
let editingTaskId = null;
const state = { courses: [], queue: [], done: [], sessions: [], linked: false, lastSync: null, weekOffset: 0 };

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
  // Session expired or signed out in another tab: go back to the login page.
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.location.replace('/login.html');
    throw new Error(data.error || 'Please sign in to continue.');
  }
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
    list.innerHTML = `<li class="empty">${
      state.linked ? 'Nothing due. Add a task or sync Canvas again.' : 'No assignments yet. Link your Canvas calendar to import them.'
    }</li>`;
    return;
  }
  list.innerHTML = state.queue
    .map((a) => {
      const due = dueLabel(a.due_at);
      const title = a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title);
      return `<li class="task" data-tone="${due.tone}">
        <input type="checkbox" data-id="${a.id}" aria-label="Mark ${esc(a.title)} complete">
        <div><div class="task-title">${title}</div><div class="task-meta">${esc(a.course_code)}</div></div>
        <div class="task-due">${esc(due.text)}
          ${a.source === 'manual' ? `<div class="task-actions"><button class="ghost small" type="button" data-edit="${a.id}">Edit</button><button class="ghost small" type="button" data-delete="${a.id}">Delete</button></div>` : ''}
        </div>
      </li>`;
    })
    .join('');
}

function renderCompleted() {
  $('#completed-list').innerHTML = state.done.length
    ? state.done.map((a) => `<li class="completed-task">
        <span>${esc(a.title)} <small>(${esc(a.course_code)})</small></span>
        <div class="task-actions">
          <button class="ghost small" type="button" data-restore="${a.id}">Restore</button>
          ${a.source === 'manual' ? `<button class="ghost small" type="button" data-edit="${a.id}">Edit</button><button class="ghost small" type="button" data-delete="${a.id}">Delete</button>` : ''}
        </div>
      </li>`).join('')
    : '<li class="empty">No completed assignments yet.</li>';
}

/* monthly-calendar-v4 */
const expandedCalendarDays = new Set();
function renderWeek() {
  // Existing Prev/Next handlers change weekOffset; now it means month offset.
  const now=new Date();
  const first=new Date(now.getFullYear(),now.getMonth()+state.weekOffset,1);
  const year=first.getFullYear(), month=first.getMonth();
  const offset=(first.getDay()+6)%7;
  const last=new Date(year,month+1,0);
  const length=Math.ceil((offset+last.getDate())/7)*7;
  const days=Array.from({length},(_,i)=>new Date(year,month,1-offset+i));
  const key=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const items=[
    ...[...state.queue,...state.done].map(a=>({kind:'task',when:new Date(a.due_at),label:a.title,tag:a.course_code,done:!!a.completed})),
    ...state.sessions.map(s=>({kind:'session',when:new Date(s.starts_at),label:s.topic||'Study session',tag:s.course_code||'Study',done:false}))
  ].filter(x=>!Number.isNaN(x.when.getTime())).sort((a,b)=>a.when-b.when);
  $('#week-h').textContent='Monthly calendar';
  $('#week-label').textContent=new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric'}).format(first);
  $('#week-grid').innerHTML=`<div class="month-weekdays" aria-hidden="true">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<div>${d}</div>`).join('')}</div>
    <div class="month-cells">${days.map(d=>{
      const day=key(d), todays=items.filter(x=>key(x.when)===day), expanded=expandedCalendarDays.has(day);
      const visible=expanded?todays:todays.slice(0,3);
      return `<div class="month-day ${d.getMonth()===month?'':'month-outside'} ${day===key(now)?'month-today':''}">
        <div class="month-date"><span>${d.getDate()}</span>${day===key(now)?'<small>Today</small>':''}</div>
        <ul class="month-day-items">${visible.map(x=>{
          const overdue=x.kind==='task'&&!x.done&&x.when<now;
          return `<li class="month-item ${x.kind} ${overdue?'month-overdue':''} ${x.done?'month-done':''}">
            <span class="month-item-title">${esc(x.label)}</span><span class="month-item-meta">${esc(timeFmt.format(x.when))} · ${esc(x.tag||'')}</span></li>`;
        }).join('')}</ul>
        ${todays.length>3?`<button type="button" class="month-more" data-calendar-day="${day}" aria-expanded="${expanded}">${expanded?'Show less':`+${todays.length-3} more`}</button>`:''}
      </div>`;
    }).join('')}</div>`;
}
$('#week-grid').addEventListener('click',e=>{
  const btn=e.target.closest('[data-calendar-day]');
  if(!btn)return;
  const day=btn.dataset.calendarDay;
  if(expandedCalendarDays.has(day))expandedCalendarDays.delete(day);
  else expandedCalendarDays.add(day);
  renderWeek();
});

function render() {
  $('#sync-btn').hidden = !state.linked;
  $('#link-btn').textContent = state.linked ? 'Change calendar link' : 'Link Canvas calendar';
  renderCourses();
  renderQueue();
  renderCompleted();
  renderWeek();
}

async function load() {
  Object.assign(state, await api('/state'));
  render();
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

$('#link-btn').onclick = () => $('#link-dialog').showModal();
function openAddTask() {
  editingTaskId = null;
  $('#task-form').reset();
  $('#task-form .error').hidden = true;
  $('#task-dialog-heading').textContent = 'Add a task';
  $('#task-submit').textContent = 'Add task';
  $('#task-dialog').showModal();
}

function openEditTask(id) {
  const a = [...state.queue, ...state.done].find((row) => String(row.id) === String(id));
  if (!a || a.source !== 'manual') return;
  editingTaskId = a.id;
  const form = $('#task-form');
  form.elements.title.value = a.title;
  form.elements.course.value = a.course_code;
  // datetime-local expects a local wall-clock time, not the UTC ISO string.
  const d = new Date(a.due_at);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  form.elements.due.value = local.toISOString().slice(0, 16);
  form.querySelector('.error').hidden = true;
  $('#task-dialog-heading').textContent = 'Edit task';
  $('#task-submit').textContent = 'Save changes';
  $('#task-dialog').showModal();
}

async function handleTaskAction(e) {
  const edit = e.target.closest('button[data-edit]');
  if (edit) { openEditTask(edit.dataset.edit); return; }
  const restore = e.target.closest('button[data-restore]');
  if (restore) {
    try {
      await api(`/assignments/${restore.dataset.restore}`, { method: 'PATCH', body: { completed: false } });
      await load();
      say('Task restored.');
    } catch (err) { say(err.message, true); }
    return;
  }
  const del = e.target.closest('button[data-delete]');
  if (del && window.confirm('Delete this manually added assignment? This cannot be undone.')) {
    try {
      await api(`/assignments/${del.dataset.delete}`, { method: 'DELETE' });
      await load();
      say('Task deleted.');
    } catch (err) { say(err.message, true); }
  }
}
$('#queue-list').addEventListener('click', handleTaskAction);
$('#completed-list').addEventListener('click', handleTaskAction);
$('#add-task-btn').onclick = openAddTask;
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

wireForm('#link-form', '/calendar/link', (f) => ({ url: f.get('url') }), (r) => `Imported ${r.imported} items from Canvas.`);
$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const error = form.querySelector('.error');
  error.hidden = true;
  try {
    const f = new FormData(form);
    const body = { title: f.get('title'), courseCode: f.get('course'), dueAt: new Date(f.get('due')).toISOString() };
    const isEdit = editingTaskId !== null;
    await api(isEdit ? `/assignments/${editingTaskId}` : '/assignments', {
      method: isEdit ? 'PUT' : 'POST', body,
    });
    $('#task-dialog').close();
    form.reset();
    editingTaskId = null;
    await load();
    say(isEdit ? 'Task updated.' : 'Task added.');
  } catch (err) { error.textContent = err.message; error.hidden = false; }
});
wireForm('#session-form', '/sessions',
  (f) => ({ courseCode: f.get('course'), topic: f.get('topic'), startsAt: new Date(f.get('start')).toISOString(), minutes: Number(f.get('minutes')) }),
  'Study session added.');

load().catch((err) => say(err.message, true));


/* ---------- logout ---------- */

document.querySelector('#logout-btn').addEventListener('click', async () => {
  const button = document.querySelector('#logout-btn');
  button.disabled = true;
  button.textContent = 'Logging out...';

  try {
    await api('/auth/logout', { method: 'POST' });
    window.location.replace('/login.html');
  } catch (error) {
    say(error.message, true);
    button.disabled = false;
    button.textContent = 'Log Out';
  }
});

/* ---------- clear Canvas ---------- */

function updateClearButton() {
  document.querySelector('#clear-btn').hidden = !state.linked;
}

const originalRender = render;

render = function () {
  originalRender();
  updateClearButton();
};

document.querySelector('#clear-btn').addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Remove all imported Canvas assignments and calendar events? ' +
    'Your manually added tasks will be kept.'
  );

  if (!confirmed) return;

  try {
    const result = await api('/calendar', { method: 'DELETE' });

    await load();

    say(
      `Cleared ${result.assignments} assignments and ` +
      `${result.events} calendar events.`
    );
  } catch (error) {
    say(error.message, true);
  }
});



/* dashboard-redesign-v1: navigation, profile and overview */
const pageNames = {dashboard:'Dashboard',calendar:'Calendar',assignments:'Assignments',courses:'Courses',analytics:'Study Analytics',goals:'Goals',settings:'Settings'};
function goToPage(page) {
  if (!Object.hasOwn(pageNames, page)) return;
  document.querySelectorAll('.app-page').forEach(el => { el.hidden = el.dataset.page !== page; });
  document.querySelectorAll('.sidebar-nav [data-nav]').forEach(el => {
    const active = el.dataset.nav === page;
    el.classList.toggle('active',active);
    if (active) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
  });
  document.querySelector('#page-title').textContent = pageNames[page];
  document.querySelector('#profile-menu').hidden = true;
  document.querySelector('#profile-toggle').setAttribute('aria-expanded','false');
  document.querySelector('#workspace').classList.remove('sidebar-open');
  document.querySelector('#sidebar-toggle').setAttribute('aria-expanded','false');
  window.scrollTo({top:0,behavior:'instant'});
}
document.querySelectorAll('[data-nav]').forEach(button => {
  button.addEventListener('click', () => goToPage(button.dataset.nav));
});
document.querySelector('#sidebar-toggle').addEventListener('click', () => {
  const open = document.querySelector('#workspace').classList.toggle('sidebar-open');
  document.querySelector('#sidebar-toggle').setAttribute('aria-expanded',String(open));
});
const profileToggle = document.querySelector('#profile-toggle');
const profileMenu = document.querySelector('#profile-menu');
profileToggle.addEventListener('click', () => {
  profileMenu.hidden = !profileMenu.hidden;
  profileToggle.setAttribute('aria-expanded',String(!profileMenu.hidden));
});
document.addEventListener('click', event => {
  if (!event.target.closest('.profile-wrap')) {
    profileMenu.hidden = true;
    profileToggle.setAttribute('aria-expanded','false');
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    profileMenu.hidden = true;
    profileToggle.setAttribute('aria-expanded','false');
    document.querySelector('#workspace').classList.remove('sidebar-open');
  }
});
async function loadAccountInfo() {
  try {
    const {user} = await api('/auth/me');
    const name = user?.name || 'Student';
    const initials = name.trim().split(/\s+/).slice(0,2).map(word=>word[0]?.toUpperCase() || '').join('');
    document.querySelector('#profile-avatar').textContent = initials || 'U';
    document.querySelector('#profile-menu-avatar').textContent = initials || 'U';
    document.querySelector('#profile-name').textContent = name;
    document.querySelector('#profile-email').textContent = user.email || '';
    document.querySelector('#profile-display-name').value = name;
    document.querySelector('#profile-display-email').value = user.email || '';
    document.querySelector('#welcome-title').textContent = `Welcome back, ${name.split(' ')[0]}!`;
  } catch (err) { say(err.message,true); }
}
/* dashboard-improvements-v3: status labels and meaningful weekly metrics */
function dashboardDeadlineStatus(iso, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { label: 'No date', tone: 'normal' };
  if (date < now) return { label: 'Overdue', tone: 'overdue' };
  if (date.toDateString() === now.toDateString()) return { label: 'Due today', tone: 'today' };
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return { label: 'Tomorrow', tone: 'soon' };
  return { label: dayFmt.format(date), tone: 'normal' };
}
function updateDashboardOverview() {
  const now = new Date();
  const upcoming = state.queue.filter(a => new Date(a.due_at) >= now);
  const overdue = state.queue.filter(a => new Date(a.due_at) < now);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  const dueThisWeek = upcoming.filter(a => {
    const d = new Date(a.due_at);
    return d >= monday && d < nextMonday;
  }).length;
  const completed = state.done.length;
  const total = state.queue.length + completed;
  const rate = total ? Math.round((completed / total) * 100) : 0;
  document.querySelector('#stat-courses').textContent = state.courses.length;
  document.querySelector('#stat-upcoming').textContent = upcoming.length;
  document.querySelector('#stat-completed').textContent = completed;
  document.querySelector('#stat-sessions').textContent = state.sessions.length;
  document.querySelector('#stat-due-week').textContent = dueThisWeek;
  document.querySelector('#stat-completion').textContent = `${rate}%`;
  const note = document.querySelector('#stat-upcoming').nextElementSibling;
  if (note) note.textContent = overdue.length ? `${overdue.length} overdue tasks also need attention` : 'Future deadlines';
  const next = [...state.queue].sort((a,b) => new Date(a.due_at) - new Date(b.due_at)).slice(0,5);
  document.querySelector('#dashboard-upcoming').innerHTML = next.length ? next.map(item => {
    const status = dashboardDeadlineStatus(item.due_at, now);
    const when = new Date(item.due_at);
    const dateLabel = Number.isNaN(when.getTime()) ? '' : dayFmt.format(when);
    return `<li><div class="overview-main">${esc(item.title)}<small>${esc(item.course_code)}</small></div><div class="overview-deadline"><span class="deadline-badge deadline-${status.tone}">${esc(status.label)}</span><time>${esc(dateLabel)}</time></div></li>`;
  }).join('') : '<li class="hint">No pending assignments. You are all caught up!</li>';
  const sessions = [...state.sessions].filter(s => new Date(s.starts_at) >= now).sort((a,b) => new Date(a.starts_at)-new Date(b.starts_at)).slice(0,4);
  document.querySelector('#dashboard-sessions').innerHTML = sessions.map(item =>
    `<li><div class="overview-main">${esc(item.topic || 'Study session')}<small>${esc(item.course_code)}</small></div><time>${esc(dayFmt.format(new Date(item.starts_at)))}</time></li>`
  ).join('');
  document.querySelector('#dashboard-session-empty').hidden = sessions.length > 0;
}

const renderWithClear = render;
render = function () {
  renderWithClear();
  updateDashboardOverview();
};
document.querySelector('#calendar-add-session').addEventListener('click', () => document.querySelector('#session-dialog').showModal());
document.querySelector('#calendar-add-task').addEventListener('click', openAddTask);
loadAccountInfo();


/* profile-settings-v2 */
function setProfileText(user) {
  const name = user.name || 'Student';
  const initials = name.trim().split(/\s+/).slice(0,2).map(x=>x[0]?.toUpperCase()||'').join('') || 'U';
  document.querySelector('#profile-avatar').textContent = initials;
  document.querySelector('#profile-menu-avatar').textContent = initials;
  document.querySelector('#profile-name').textContent = name;
  document.querySelector('#profile-email').textContent = user.email || '';
  document.querySelector('#welcome-title').textContent = `Welcome back, ${name.split(/\s+/)[0]}!`;
  document.querySelector('#profile-display-name').value = name;
  document.querySelector('#profile-display-email').value = user.email || '';
}
async function loadProfileSettings() {
  try {
    const [account, preferences] = await Promise.all([api('/auth/me'),api('/auth/preferences')]);
    setProfileText(account.user);
    const p = preferences.preferences || {};
    document.querySelector('#profile-university').value = p.university || '';
    document.querySelector('#profile-major').value = p.major || '';
    document.querySelector('#profile-weekly-hours').value = p.weeklyHours || '10';
    document.querySelector('#profile-session-length').value = p.sessionMinutes || '45';
  } catch (err) { say(err.message,true); }
}
function submitSettings(formSelector, feedbackSelector, endpoint, makeBody, onSaved) {
  const form = document.querySelector(formSelector);
  form.addEventListener('submit',async event => {
    event.preventDefault();
    const feedback = document.querySelector(feedbackSelector);
    const button = form.querySelector('button[type="submit"]');
    feedback.textContent = '';
    feedback.classList.remove('is-error');
    button.disabled = true;
    try {
      const response = await api(endpoint,{method:'PUT',body:makeBody(new FormData(form))});
      if (onSaved) onSaved(response);
      feedback.textContent = 'Saved successfully.';
    } catch (err) {
      feedback.textContent = err.message;
      feedback.classList.add('is-error');
    } finally { button.disabled = false; }
  });
}
submitSettings('#profile-form','#profile-feedback','/auth/profile',f=>({name:f.get('name'),email:f.get('email')}),r=>setProfileText(r.user));
submitSettings('#preferences-form','#preferences-feedback','/auth/preferences',f=>({
  university:f.get('university'), major:f.get('major'),weeklyHours:Number(f.get('weeklyHours')),sessionMinutes:Number(f.get('sessionMinutes'))
}));
// Existing v1 navigation already routes data-nav="settings" to the Settings page.
// Scroll to the corresponding subsection after the page is made visible.
document.querySelectorAll('.profile-menu [data-section]').forEach(button=>{
  button.addEventListener('click',()=>{
    const section=document.getElementById(button.dataset.section);
    if(section) section.scrollIntoView({behavior:'smooth',block:'start'});
  });
});
loadProfileSettings();

// dashboard-improvements-v3: reuse the existing study-session dialog.
document.querySelector('#dashboard-add-session').addEventListener('click', () =>
  document.querySelector('#session-dialog').showModal());
