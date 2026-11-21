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
    ...[...state.queue,...state.done].map(a=>({kind:'task',id:a.id,when:new Date(a.due_at),label:a.title,tag:a.course_code,done:!!a.completed})),
    ...state.sessions.map(s=>({kind:'session',id:s.id,when:new Date(s.starts_at),label:s.topic||'Study session',tag:s.course_code||'Study',done:false}))
  ].filter(x=>!Number.isNaN(x.when.getTime())).sort((a,b)=>a.when-b.when);
  $('#week-h').textContent='Monthly calendar';
  $('#week-label').textContent=new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric'}).format(first);
  $('#week-grid').innerHTML=`<div class="month-weekdays" aria-hidden="true">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<div>${d}</div>`).join('')}</div>
    <div class="month-cells">${days.map(d=>{
      const day=key(d), todays=items.filter(x=>key(x.when)===day), expanded=expandedCalendarDays.has(day);
      const visible=expanded?todays:todays.slice(0,3);
      return `<div tabindex="0" role="button" data-open-day="${day}" aria-label="Plan items for ${day}" class="month-day ${d.getMonth()===month?'':'month-outside'} ${day===key(now)?'month-today':''}">
        <div class="month-date"><button type="button" class="month-day-open" data-open-day="${day}" aria-label="Actions for ${day}">${d.getDate()}</button>${day===key(now)?'<small>Today</small>':''}</div>
        <ul class="month-day-items">${visible.map(x=>{
          const overdue=x.kind==='task'&&!x.done&&x.when<now;
          return `<li tabindex="0" role="button" data-calendar-item="${x.kind}" data-item-id="${x.id}" class="month-item ${x.kind} ${overdue?'month-overdue':''} ${x.done?'month-done':''}">
            <span class="month-item-title">${esc(x.label)}</span><span class="month-item-meta">${esc(timeFmt.format(x.when))} · ${esc(x.tag||'')}</span></li>`;
        }).join('')}</ul>
        ${todays.length>3?`<button type="button" class="month-more" data-calendar-day="${day}" aria-expanded="${expanded}">${expanded?'Show less':`+${todays.length-3} more`}</button>`:''}
      </div>`;
    }).join('')}</div>`;
}
/* interactive-calendar-v5 */
const detailDialog = document.querySelector('#calendar-detail-dialog');
const detailContent = document.querySelector('#calendar-detail-content');
const detailActions = document.querySelector('#calendar-detail-actions');
const detailError = document.querySelector('#calendar-detail-error');
const localDateForInput = date => {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0,16);
};
const selectedDayDate = key => {
  const [y,m,d] = key.split('-').map(Number);
  return new Date(y,m-1,d,12,0);
};
function openDayActions(key) {
  const date = selectedDayDate(key);
  if (Number.isNaN(date.getTime())) return;
  document.querySelector('#calendar-detail-type').textContent = 'DAY PLANNER';
  document.querySelector('#calendar-detail-title').textContent =
    new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(date);
  detailContent.textContent = 'What would you like to plan on this day?';
  detailActions.replaceChildren();
  detailError.hidden = true;
  const task = document.createElement('button');
  task.textContent = 'Add assignment';
  task.type = 'button';
  task.onclick = () => {
    detailDialog.close();
    openAddTask();
    const due = new Date(date);
    due.setHours(23,59,0,0);
    document.querySelector('#task-form').elements.due.value = localDateForInput(due);
  };
  const session = document.createElement('button');
  session.textContent = 'Plan study session';
  session.type = 'button';
  session.className = 'ghost';
  session.onclick = () => {
    detailDialog.close();
    const form = document.querySelector('#session-form');
    form.reset();
    form.elements.start.value = localDateForInput(date);
    document.querySelector('#session-dialog').showModal();
  };
  detailActions.append(task,session);
  detailDialog.showModal();
}
function openCalendarItem(kind,id) {
  const a = kind === 'task'
    ? [...state.queue,...state.done].find(x=>String(x.id)===String(id))
    : state.sessions.find(x=>String(x.id)===String(id));
  if (!a) { say('That calendar item is no longer available.',true); return; }
  const isTask = kind === 'task';
  document.querySelector('#calendar-detail-type').textContent =
    isTask ? (a.source === 'canvas' ? 'CANVAS ASSIGNMENT' : 'ASSIGNMENT') : 'STUDY SESSION';
  document.querySelector('#calendar-detail-title').textContent =
    isTask ? a.title : (a.topic || 'Study session');
  const when = new Date(isTask ? a.due_at : a.starts_at);
  const readable = Number.isNaN(when.getTime()) ? 'Unknown' :
    new Intl.DateTimeFormat(undefined,{dateStyle:'full',timeStyle:'short'}).format(when);
  detailContent.replaceChildren();
  const rows = [
    ['Course',a.course_code || 'General'],
    [isTask?'Due':'Starts',readable],
    [isTask?'Status':'Duration',isTask?(a.completed?'Completed':'Not completed'):(a.minutes+' minutes')],
  ];
  for(const [label,value] of rows) {
    const row = document.createElement('div');
    row.className = 'calendar-info-row';
    const name = document.createElement('span');
    name.textContent = label;
    const data = document.createElement('strong');
    data.textContent = value;
    row.append(name,data);
    detailContent.append(row);
  }
  if (isTask && a.url && /^https?:\/\//i.test(a.url)) {
    const link = document.createElement('a');
    link.href = a.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open assignment in Canvas ↗';
    detailContent.append(link);
  }
  detailError.hidden = true;
  detailActions.replaceChildren();
  if(isTask) {
    const complete = document.createElement('button');
    complete.type='button';
    complete.textContent = a.completed ? 'Mark incomplete' : 'Mark complete';
    complete.onclick = async()=>{
      complete.disabled = true;
      try {
        await api(`/assignments/${a.id}`,{method:'PATCH',body:{completed:!a.completed}});
        detailDialog.close();
        await load();
        say('Assignment updated.');
      } catch(err) {
        detailError.textContent=err.message;
        detailError.hidden=false;
        complete.disabled=false;
      }
    };
    detailActions.append(complete);
    if(a.source==='manual') {
      const edit=document.createElement('button');
      edit.type='button';
      edit.className='ghost';
      edit.textContent='Edit assignment';
      edit.onclick=()=>{detailDialog.close();openEditTask(a.id);};
      detailActions.append(edit);
      // calendar-usability-v6: only manual assignments can be deleted.
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ghost calendar-delete-action';
      remove.textContent = 'Delete assignment';
      remove.onclick = async () => {
        if (!window.confirm(`Permanently delete "${a.title}"? This cannot be undone.`)) return;
        remove.disabled = true;
        detailError.hidden = true;
        try {
          await api(`/assignments/${a.id}`, {method:'DELETE'});
          detailDialog.close();
          await load();
          say('Assignment deleted.');
        } catch (err) {
          detailError.textContent = err.message;
          detailError.hidden = false;
          remove.disabled = false;
        }
      };
      detailActions.append(remove);
    }
  } else {
    const close=document.createElement('button');
    close.type='button';
    close.className='ghost';
    close.textContent='Close';
    close.onclick=()=>detailDialog.close();
    detailActions.append(close);
  }
  detailDialog.showModal();
}
document.querySelector('#calendar-detail-close').addEventListener('click',()=>detailDialog.close());
$('#week-grid').addEventListener('click',e=>{
  const item=e.target.closest('[data-calendar-item]');
  if(item) {
    openCalendarItem(item.dataset.calendarItem,item.dataset.itemId);
    return;
  }
  const dayButton=e.target.closest('.month-day[data-open-day]');
  const btn=e.target.closest('[data-calendar-day]');
  // Keep expand/collapse controls working without opening the day planner.
  if (!btn && dayButton) {openDayActions(dayButton.dataset.openDay);return;}
  if(!btn)return;
  const day=btn.dataset.calendarDay;
  if(expandedCalendarDays.has(day))expandedCalendarDays.delete(day);
  else expandedCalendarDays.add(day);
  renderWeek();
});
$('#week-grid').addEventListener('keydown',e=>{
  if(e.key!=='Enter' && e.key!==' ')return;
  const item=e.target.closest('[data-calendar-item]');
  if(item) {
    e.preventDefault();
    openCalendarItem(item.dataset.calendarItem,item.dataset.itemId);
    return;
  }
  // Only trigger when the focused element is the cell itself, not a child button.
  const day=e.target.matches('.month-day[data-open-day]') ? e.target : null;
  if(day) {
    e.preventDefault();
    openDayActions(day.dataset.openDay);
  }
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
  if (typeof currentProfilePhotoUrl !== 'undefined' && !currentProfilePhotoUrl) updatePhotoHolders(null);
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

/* advanced-assignments-v7: search/filter/sort existing rendered rows, no API changes */
const assignmentFilters = { search:'', course:'', status:'all', sort:'due-asc' };
const assignmentSearch = document.querySelector('#assignment-search');
const assignmentCourse = document.querySelector('#assignment-course');
const assignmentStatus = document.querySelector('#assignment-status');
const assignmentSort = document.querySelector('#assignment-sort');
function applyAssignmentFilters() {
  const codes = [...new Set(state.courses.map(c=>c.code).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  assignmentCourse.replaceChildren(new Option('All courses',''));
  codes.forEach(code=>assignmentCourse.add(new Option(code,code)));
  if (!codes.includes(assignmentFilters.course)) assignmentFilters.course='';
  assignmentCourse.value=assignmentFilters.course;
  const activeNodes=[...document.querySelectorAll('#queue-list > li.task')];
  const doneNodes=[...document.querySelectorAll('#completed-list > li.completed-task')];
  const rows=[
    ...state.queue.map(item=>({item,node:activeNodes.find(node=>node.querySelector('input[data-id]')?.dataset.id===String(item.id)),completed:false})),
    ...state.done.map(item=>({item,node:doneNodes.find(node=>node.querySelector('button[data-restore]')?.dataset.restore===String(item.id)),completed:true}))
  ].filter(row=>row.node);
  const now=new Date();
  const dayStart=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const nextDay=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  function matches({item,completed}) {
    const haystack=`${item.title||''} ${item.course_code||''}`.toLocaleLowerCase();
    if (!haystack.includes(assignmentFilters.search))return false;
    if (assignmentFilters.course && item.course_code!==assignmentFilters.course)return false;
    const due=new Date(item.due_at), status=assignmentFilters.status;
    if(status==='completed'&&!completed)return false;
    if(status==='active'&&completed)return false;
    if(['overdue','today','upcoming'].includes(status)) {
      if(completed||Number.isNaN(due.getTime()))return false;
      if(status==='overdue'&&!(due<now))return false;
      if(status==='today'&&!(due>=dayStart&&due<nextDay))return false;
      if(status==='upcoming'&&!(due>=now))return false;
    }
    return true;
  }
  const compare=(a,b)=>{
    const due=()=>new Date(a.item.due_at)-new Date(b.item.due_at);
    if(assignmentFilters.sort==='due-desc')return -due();
    if(assignmentFilters.sort==='priority')return (Number(b.item.course_priority)||0)-(Number(a.item.course_priority)||0)||due();
    if(assignmentFilters.sort==='title')return String(a.item.title||'').localeCompare(String(b.item.title||''));
    return due();
  };
  const visible=rows.filter(matches);
  const visibleNodes=new Set(visible.map(row=>row.node));
  rows.forEach(row=>row.node.hidden=!visibleNodes.has(row.node));
  for(const [selector,completed] of [['#queue-list',false],['#completed-list',true]]) {
    const list=document.querySelector(selector);
    rows.filter(row=>row.completed===completed).sort(compare).forEach(row=>list.append(row.node));
  }
  const activeCount=visible.filter(row=>!row.completed).length;
  document.querySelector('#assignment-result-summary').textContent=`${visible.length} matching assignment${visible.length===1?'':'s'} - ${activeCount} active, ${visible.length-activeCount} completed`;
  document.querySelector('#assignment-no-results').hidden=visible.length!==0||rows.length===0;
  document.querySelectorAll('#queue-list > li.empty, #completed-list > li.empty').forEach(el=>{
    el.hidden=rows.length>0&&(assignmentFilters.search!==''||assignmentFilters.course!==''||assignmentFilters.status!=='all');
  });
}
assignmentSearch.addEventListener('input',e=>{assignmentFilters.search=e.target.value.trim().toLocaleLowerCase();applyAssignmentFilters();});
assignmentCourse.addEventListener('change',e=>{assignmentFilters.course=e.target.value;applyAssignmentFilters();});
assignmentStatus.addEventListener('change',e=>{assignmentFilters.status=e.target.value;applyAssignmentFilters();});
assignmentSort.addEventListener('change',e=>{assignmentFilters.sort=e.target.value;applyAssignmentFilters();});
document.querySelector('#assignment-reset').addEventListener('click',()=>{
  Object.assign(assignmentFilters,{search:'',course:'',status:'all',sort:'due-asc'});
  assignmentSearch.value='';assignmentStatus.value='all';assignmentSort.value='due-asc';
  applyAssignmentFilters();
});
const priorAssignmentsRender=render;
render=function(){priorAssignmentsRender();applyAssignmentFilters();};
applyAssignmentFilters();


/* study-analytics-v8: real account data, no extra backend endpoint. */
function renderStudyAnalytics() {
  const all = [...state.queue, ...state.done];
  const done = all.filter(item => Boolean(item.completed));
  const active = all.filter(item => !item.completed);
  const now = new Date();
  const overdue = active.filter(item => {
    const due = new Date(item.due_at);
    return !Number.isNaN(due.getTime()) && due < now;
  });
  const total = all.length;
  const rate = total ? Math.round(done.length * 100 / total) : 0;
  const set = (id, value) => { document.querySelector(id).textContent = String(value); };
  set('#analytics-total', total);
  set('#analytics-done', done.length);
  set('#analytics-overdue', overdue.length);
  set('#analytics-completion-label', `${rate}% of tracked assignments`);
  set('#analytics-rate', `${rate}%`);
  set('#analytics-legend-done', done.length);
  set('#analytics-legend-active', active.length);
  set('#analytics-legend-late', overdue.length);
  const donut = document.querySelector('#analytics-donut');
  donut.style.background = total
    ? `conic-gradient(#146846 0% ${rate}%, #d6e3d9 ${rate}% 100%)`
    : '#e2eae5';
  donut.setAttribute('aria-label', total
    ? `${done.length} of ${total} assignments completed (${rate} percent)`
    : 'No assignments to display');

  // Monday 00:00 local time through following Monday 00:00 local time.
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
  const buckets = Array(7).fill(0);
  for (const session of state.sessions) {
    const start = new Date(session.starts_at);
    const minutes = Number(session.minutes);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(minutes) || minutes <= 0) continue;
    const end = new Date(start.getTime() + minutes * 60000);
    const overlapStart = Math.max(start.getTime(), weekStart.getTime());
    const overlapEnd = Math.min(end.getTime(), weekEnd.getTime());
    if (overlapEnd <= overlapStart) continue;
    // Split across local midnights so daily bars remain correct.
    let cursor = overlapStart;
    while (cursor < overlapEnd) {
      const dt = new Date(cursor);
      const nextDay = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()+1).getTime();
      const finish = Math.min(overlapEnd, nextDay);
      const idx = (dt.getDay()+6)%7;
      buckets[idx] += (finish-cursor)/3600000;
      cursor=finish;
    }
  }
  const weeklyHours = buckets.reduce((sum,n)=>sum+n,0);
  set('#analytics-week-hours', `${Number(weeklyHours.toFixed(1))} h`);
  const rangeFmt = new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'});
  set('#analytics-week-range', `${rangeFmt.format(weekStart)} – ${rangeFmt.format(new Date(weekEnd.getTime()-1))}`);
  const maxHours = Math.max(1, ...buckets);
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const chart = document.querySelector('#analytics-week-chart');
  chart.replaceChildren();
  buckets.forEach((hours,i) => {
    const col = document.createElement('div'); col.className='analytics-day';
    const value = document.createElement('span'); value.className='analytics-day-value';
    value.textContent=hours ? `${Number(hours.toFixed(1))}h` : '0h';
    const track=document.createElement('div'); track.className='analytics-bar-track';
    const bar=document.createElement('div'); bar.className='analytics-bar';
    bar.style.height=`${Math.max(0,Math.min(100,hours/maxHours*100))}%`;
    bar.title=`${days[i]}: ${Number(hours.toFixed(2))} scheduled hours`;
    track.append(bar);
    const label=document.createElement('span'); label.className='analytics-day-name';label.textContent=days[i];
    col.append(value,track,label); chart.append(col);
  });
  chart.setAttribute('aria-label', days.map((d,i)=>`${d}: ${Number(buckets[i].toFixed(1))} hours scheduled`).join(', '));
  const goalInput = document.querySelector('#profile-weekly-hours');
  const preferred = Number(goalInput?.value || 10);
  const goal = Number.isFinite(preferred) && preferred > 0 ? preferred : 10;
  const pct = Math.min(100,Math.round(weeklyHours/goal*100));
  set('#analytics-goal-progress', `${Number(weeklyHours.toFixed(1))} / ${goal} h`);
  set('#analytics-goal-caption', `${pct}% of your weekly goal scheduled`);
  document.querySelector('#analytics-goal-fill').style.width=`${pct}%`;
  document.querySelector('#analytics-goal-bar').setAttribute('aria-valuenow',String(pct));

  const list=document.querySelector('#analytics-courses');
  list.replaceChildren();
  const data = state.courses.map(course=>{
    const assignments=all.filter(a=>String(a.course_id)===String(course.id));
    return {code:course.code, total:assignments.length,done:assignments.filter(a=>Boolean(a.completed)).length};
  }).filter(entry=>entry.total>0).sort((a,b)=>a.code.localeCompare(b.code));
  if (!data.length) {
    const empty=document.createElement('p');empty.className='analytics-note';
    empty.textContent='No assignments yet. Add an assignment or import your Canvas calendar to see course progress.';
    list.append(empty);
  }
  for (const course of data) {
    const percent=Math.round(course.done/course.total*100);
    const row=document.createElement('div');row.className='analytics-course-row';
    const heading=document.createElement('div');heading.className='analytics-course-heading';
    const name=document.createElement('strong');name.textContent=course.code;
    const count=document.createElement('span');count.textContent=`${course.done} / ${course.total} completed · ${percent}%`;
    heading.append(name,count);
    const track=document.createElement('div');track.className='analytics-progress-track';
    const fill=document.createElement('div'); fill.style.width=`${percent}%`;track.append(fill);
    row.append(heading,track);list.append(row);
  }
}
const renderBeforeAnalyticsV8=render;
render=function(){renderBeforeAnalyticsV8();renderStudyAnalytics();};
renderStudyAnalytics();


/* goals-focus-v9: weekly goal, real study logs, and a browser focus stopwatch. */
const focusUi = {
  started: null, elapsedMs: 0, ticker: null,
};
function focusElapsedMs() {
  return focusUi.elapsedMs + (focusUi.started === null ? 0 : Date.now() - focusUi.started);
}
function focusFormat(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60]
    .map(n=>String(n).padStart(2,'0')).join(':');
}
function focusRefreshClock() {
  document.querySelector('#focus-clock').textContent=focusFormat(focusElapsedMs());
  const running=focusUi.started!==null, elapsed=focusElapsedMs();
  document.querySelector('#focus-start').disabled=running;
  document.querySelector('#focus-start').textContent=elapsed?'Resume':'Start';
  document.querySelector('#focus-pause').disabled=!running;
  document.querySelector('#focus-reset').disabled=elapsed===0;
  document.querySelector('#focus-save').disabled=running||elapsed<60000||elapsed>240*60000;
  document.querySelector('#focus-state').textContent=running?'Focusing':elapsed?'Paused':'Ready';
}
function focusStopTicker() {
  if(focusUi.ticker!==null) clearInterval(focusUi.ticker);
  focusUi.ticker=null;
}
document.querySelector('#focus-start').addEventListener('click',()=>{
  if(focusUi.started!==null)return;
  focusUi.started=Date.now();
  focusStopTicker();
  focusUi.ticker=setInterval(focusRefreshClock,250);
  focusRefreshClock();
});
document.querySelector('#focus-pause').addEventListener('click',()=>{
  if(focusUi.started===null)return;
  focusUi.elapsedMs+=Date.now()-focusUi.started;
  focusUi.started=null;
  focusStopTicker();focusRefreshClock();
});
document.querySelector('#focus-reset').addEventListener('click',()=>{
  if(focusElapsedMs()>0 && !window.confirm('Discard the current unsaved focus time?'))return;
  focusUi.elapsedMs=0;focusUi.started=null;focusStopTicker();focusRefreshClock();
});
document.querySelector('#focus-save').addEventListener('click',async()=>{
  if(focusUi.started!==null)return;
  const minutes=Math.floor(focusUi.elapsedMs/60000);
  if(minutes<1 || minutes>240)return;
  const btn=document.querySelector('#focus-save'),feedback=document.querySelector('#focus-feedback');
  btn.disabled=true;
  feedback.textContent='Saving your session…';
  try {
    await api('/focus-logs',{method:'POST',body:{
      minutes,courseCode:document.querySelector('#focus-course').value,
      topic:document.querySelector('#focus-topic').value.trim()
    }});
    focusUi.elapsedMs=0;focusUi.started=null;focusStopTicker();focusRefreshClock();
    feedback.textContent=`Saved ${minutes} minute${minutes===1?'':'s'} of actual study time.`;
    await load();
  }catch(err){feedback.textContent=`Could not save: ${err.message}`;focusRefreshClock();}
});
function focusWeekBounds() {
  const now=new Date();
  const mon=new Date(now.getFullYear(),now.getMonth(),now.getDate()-((now.getDay()+6)%7));
  const next=new Date(mon.getFullYear(),mon.getMonth(),mon.getDate()+7);
  return {mon,next};
}
function renderGoalsFocus() {
  const {mon,next}=focusWeekBounds();
  const weekly=(state.focusLogs||[]).filter(log=>{
    const time=new Date(log.finished_at);
    return time>=mon && time<next;
  });
  const minutes=weekly.reduce((sum,log)=>sum+(Number(log.minutes)||0),0);
  const hrs=minutes/60;
  const goalInput=document.querySelector('#profile-weekly-hours');
  const goalNumber=Number(goalInput?.value);
  const goal=Number.isFinite(goalNumber)&&goalNumber>0?goalNumber:10;
  const pct=Math.min(100,Math.round(hrs/goal*100));
  const hoursLabel=Number(hrs.toFixed(1));
  const set=(id,value)=>{document.querySelector(id).textContent=String(value)};
  set('#focus-goal',`${goal} h`);
  set('#focus-week',`${hoursLabel} h`);
  set('#focus-goal-progress',`${hoursLabel} / ${goal} h`);
  set('#focus-goal-percent',`${pct}%`);
  set('#analytics-actual-hours',`${hoursLabel} h`);
  document.querySelector('#focus-goal-fill').style.width=`${pct}%`;
  document.querySelector('#focus-progress').setAttribute('aria-valuenow',String(pct));
  const plan=state.sessions.reduce((sum,s)=>{
    const start=new Date(s.starts_at).getTime(),mins=Number(s.minutes);
    if(!Number.isFinite(start)||!Number.isFinite(mins)||mins<=0)return sum;
    return sum+Math.max(0,Math.min(start+mins*60000,next.getTime())-Math.max(start,mon.getTime()))/3600000;
  },0);
  set('#focus-planned',`${Number(plan.toFixed(1))} h`);
  const select=document.querySelector('#focus-course'),selected=select.value;
  select.replaceChildren(new Option('General study',''));
  for(const course of state.courses){select.add(new Option(course.code,course.code));}
  if([...select.options].some(o=>o.value===selected))select.value=selected;
  const history=document.querySelector('#focus-history');history.replaceChildren();
  if(!weekly.length){
    const li=document.createElement('li');li.textContent='No focus sessions saved this week yet.';history.append(li);
  }else for(const log of weekly.slice(0,8)){
    const li=document.createElement('li');
    const name=document.createElement('strong');name.textContent=log.topic||log.course_code||'Focused study';
    const meta=document.createElement('span');
    meta.textContent=`${log.minutes} min · ${new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric'}).format(new Date(log.finished_at))}`;
    li.append(name,meta);history.append(li);
  }
}
document.querySelector('#focus-edit-goal').addEventListener('click',()=>{
  goToPage('settings');
  document.querySelector('#academic-preferences').scrollIntoView({behavior:'smooth',block:'start'});
  document.querySelector('#profile-weekly-hours').focus({preventScroll:true});
});
const renderBeforeGoalsV9=render;
render=function(){renderBeforeGoalsV9();renderGoalsFocus();};
// Update the progress card when preferences are saved, without needing another page reload.
document.querySelector('#preferences-form').addEventListener('submit',()=>setTimeout(renderGoalsFocus,250));
focusRefreshClock();
renderGoalsFocus();


/* profile-photos-v11: authenticated profile image with initials fallback. */
let currentProfilePhotoUrl = null;
const photoHolderSelectors = ['#profile-avatar','#profile-menu-avatar','#profile-photo-preview'];
function updatePhotoHolders(photoUrl) {
  const initials = (document.querySelector('#profile-name').textContent || 'Student')
    .trim().split(/\s+/).slice(0,2).map(word=>word[0]?.toUpperCase()||'').join('') || 'U';
  for (const selector of photoHolderSelectors) {
    const holder = document.querySelector(selector);
    if (!holder) continue;
    holder.replaceChildren();
    if (photoUrl) {
      const image = document.createElement('img');
      image.src = photoUrl;
      image.alt = 'Your profile picture';
      holder.append(image);
    } else {
      holder.textContent = initials;
    }
  }
}
async function refreshProfilePhoto() {
  let newUrl = null;
  try {
    const response = await fetch('/api/auth/avatar', {cache:'no-store'});
    if (response.status === 401) return;
    if (response.ok) newUrl = URL.createObjectURL(await response.blob());
    else if (response.status !== 404) throw new Error('Unable to load profile photo.');
  } catch (err) { say(err.message,true); return; }
  const oldUrl = currentProfilePhotoUrl;
  currentProfilePhotoUrl = newUrl;
  updatePhotoHolders(newUrl);
  if (oldUrl) URL.revokeObjectURL(oldUrl);
}
const photoFile = document.querySelector('#profile-photo-file');
const photoFeedback = document.querySelector('#profile-photo-feedback');
const photoUpload = document.querySelector('#profile-photo-upload');
const photoRemove = document.querySelector('#profile-photo-remove');
photoUpload.addEventListener('click', async () => {
  const file = photoFile.files?.[0];
  if (!file) { photoFeedback.textContent='Choose a picture first.'; return; }
  if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size>2*1024*1024) {
    photoFeedback.textContent='Please choose a JPG, PNG, or WebP under 2 MB.'; return;
  }
  photoUpload.disabled=true;
  photoFeedback.textContent='Uploading…';
  try {
    const response=await fetch('/api/auth/avatar',{
      method:'PUT',headers:{'Content-Type':file.type},body:file
    });
    const result=await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(result.error||'Upload failed.');
    await refreshProfilePhoto();
    photoFeedback.textContent='Profile picture saved.';
    photoFile.value='';
  } catch (err) { photoFeedback.textContent=err.message; }
  finally {photoUpload.disabled=false;}
});
photoRemove.addEventListener('click', async () => {
  if (!confirm('Remove your profile picture? Your initials will appear instead.')) return;
  photoRemove.disabled=true;
  try {
    const response=await fetch('/api/auth/avatar',{method:'DELETE'});
    if (!response.ok) throw new Error('Unable to remove profile picture.');
    await refreshProfilePhoto();
    photoFeedback.textContent='Profile picture removed.';
    photoFile.value='';
  } catch (err) {photoFeedback.textContent=err.message;}
  finally {photoRemove.disabled=false;}
});
refreshProfilePhoto();
