import { Simulation, scenarios, comparison, type Scenario } from '../core/simulation.js';
import { assertCapacity, usage, policies, type Policy, type Job } from '../core/model.js';
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const examples = scenarios();
let source: Scenario = structuredClone(examples[0]!),
  sim = new Simulation(source.config, source.groups, source.jobs),
  view = 'queue',
  timer: ReturnType<typeof setInterval> | undefined,
  groupFilter = 'all',
  stateFilter = 'all',
  search = '',
  page = 0,
  race = comparison(source);
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
function notice(text: string) {
  $('#notice').textContent = text;
  $('#notice').hidden = !text;
}
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  $('#play').textContent = 'Run simulation';
  $('#play').setAttribute('aria-pressed', 'false');
}
function reset() {
  stop();
  sim = new Simulation({ ...source.config }, source.groups, source.jobs);
  race = comparison(source);
  groupFilter = 'all';
  stateFilter = 'all';
  search = '';
  page = 0;
  notice('');
  render();
}
function scenarioTabs() {
  $('#scenarios').innerHTML = examples
    .map(
      (s, i) =>
        `<button class="scenario-tab ${s.id === source.id ? 'selected' : ''}" data-scenario="${s.id}" aria-pressed="${s.id === source.id}"><span>${['≋', '▦', '◇', '↺'][i]}</span><div><strong>${esc(s.label)}</strong><small>${['Fair access', 'Resource fit', 'Aging guard', 'Lease fencing'][i]}</small></div></button>`,
    )
    .join('');
}
function resourceCells(kind: 'cpu' | 'gpu') {
  const capacity = sim.config[kind],
    used = sim.running().flatMap((j) => Array.from({ length: j[kind] }, () => j.group));
  return `<div class="resource-detail"><div><span>${kind.toUpperCase()}</span><b>${used.length} / ${capacity}</b></div><div class="resource-cells" aria-label="${used.length} of ${capacity} ${kind.toUpperCase()} units reserved">${capacity ? Array.from({ length: capacity }, (_, i) => `<span class="resource-unit ${used[i] ?? ''}" title="${esc(used[i] ?? 'available')}"></span>`).join('') : '<span class="resource-zero">Not in this workload</span>'}</div></div>`;
}
function groupCards() {
  return `<div class="group-overview">${sim.groups
    .map((g) => {
      const active = sim.running().filter((j) => j.group === g.id),
        queued = sim.jobs.filter((j) => j.group === g.id && j.status === 'QUEUED'),
        own = usage(active);
      return `<div class="group-card"><div class="group-card-top"><span class="group-dot ${g.id}"></span>${esc(g.name)}<span>weight ${g.weight}×</span></div><div class="group-card-bottom"><span><strong>${active.length}</strong> running · ${queued.length} queued</span><span>${own.cpu} CPU / ${own.gpu} GPU</span></div></div>`;
    })
    .join('')}</div>`;
}
function render() {
  scenarioTabs();
  $('#scenario-title').textContent = source.label;
  $('#scenario-description').textContent = source.description;
  $('#time').textContent = String(sim.time).padStart(2, '0');
  $<HTMLSelectElement>('#policy').value = sim.config.policy;
  const queued = sim.jobs.filter((j) => j.status === 'QUEUED').length,
    done = sim.jobs.filter((j) => j.status === 'SUCCEEDED').length;
  $('#workspace').innerHTML =
    `<div class="status-grid"><div class="status-cell"><span class="status-label">Reserved cluster capacity</span><div class="resource-lines">${resourceCells('cpu')}${resourceCells('gpu')}</div></div><div class="status-cell"><span class="status-label">Waiting in queue</span><div class="status-value"><strong>${queued}</strong> jobs</div></div><div class="status-cell"><span class="status-label">Completed</span><div class="status-value"><strong>${done}</strong> / ${sim.jobs.length}</div></div><div class="status-cell"><span class="status-label">Worker slots</span><div class="status-value"><strong>${sim.running().length}</strong> / ${sim.config.workers}</div></div></div><div class="workspace-body">${groupCards()}${view === 'queue' ? queueView() : view === 'allocations' ? allocations() : view === 'recovery' ? recovery() : evidence()}<div class="decision"><strong>Latest scheduling decision</strong>${esc(sim.decision)}</div></div>`;
  document
    .querySelectorAll<HTMLElement>('.sidebar [data-view]')
    .forEach((el) => el.classList.toggle('active', el.dataset.view === view));
  if (sim.complete()) {
    stop();
    notice(
      'Experiment complete. The event log and exported report contain every dispatch, release, and result.',
    );
  }
  if (view === 'queue') {
    bindQueue();
    renderTable();
  }
}
function raceCard() {
  const fifo = race.find((r) => r.policy === 'fifo')!,
    fair = race.find((r) => r.policy === 'fair')!,
    guard = race.find((r) => r.policy === 'guard')!,
    b = (r: typeof fifo) => r.groups.find((g) => g.id === 'boreal')!;
  return `<div class="race-card"><p class="eyebrow">SAME WORKLOAD · DIFFERENT POLICY</p><h3>How long does Boreal wait?</h3><div class="race-row fifo"><span>Strict FIFO</span><span><b>${fmt(b(fifo).firstStart ?? 0)}</b> ticks</span></div><div class="race-row"><span>Weighted fair</span><span><b>${fmt(b(fair).firstStart ?? 0)}</b> ticks</span></div><div class="race-row"><span>Fair + aging guard</span><span><b>${fmt(b(guard).firstStart ?? 0)}</b> ticks</span></div><p>First start wait, computed from the complete reference workload. Interactive additions and worker faults are separate experiments.</p></div>`;
}
function activity() {
  return `<div class="activity"><h3>Recent decisions</h3>${
    sim.events
      .filter((e) => e.kind !== 'SUBMITTED')
      .slice(-4)
      .reverse()
      .map(
        (e) =>
          `<div class="activity-item"><time>t+${e.time}</time><strong>${esc(e.kind.toLowerCase().replaceAll('_', ' '))}</strong><p>${e.job ?? ''} ${esc(e.detail)}</p></div>`,
      )
      .join('') || '<p class="evidence-hint">Advance the clock to see scheduling decisions.</p>'
  }</div>`;
}
function queueView() {
  return `<div class="work-grid"><section><div class="section-head"><h3>Research job queue</h3><span>${sim.jobs.length} submitted</span></div><div class="queue-tools"><select id="group-filter" aria-label="Filter jobs by group"><option value="all">All groups</option>${sim.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select><select id="state-filter" aria-label="Filter jobs by state"><option value="all">All states</option>${['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map((s) => `<option value="${s}">${s.toLowerCase()}</option>`).join('')}</select><input class="queue-search" id="job-search" type="search" aria-label="Search jobs" placeholder="Search job name or ID" value="${esc(search)}"></div><div id="queue-table"></div></section><aside class="side-panel">${raceCard()}${activity()}</aside></div>${timeline()}`;
}
function bindQueue() {
  $<HTMLSelectElement>('#group-filter').value = groupFilter;
  $<HTMLSelectElement>('#state-filter').value = stateFilter;
}
function renderTable() {
  const jobs = sim.jobs.filter(
    (j) =>
      (groupFilter === 'all' || j.group === groupFilter) &&
      (stateFilter === 'all' || j.status === stateFilter) &&
      `${j.id} ${j.label}`.toLowerCase().includes(search.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(jobs.length / 8));
  page = Math.min(page, pages - 1);
  const rows = jobs.slice(page * 8, page * 8 + 8);
  $('#queue-table').innerHTML =
    `<div class="table-wrap"><table class="queue-table"><thead><tr><th>JOB</th><th>GROUP</th><th>CPU / GPU</th><th>STATE</th><th>ATTEMPT</th><th><span class="sr-only">Action</span></th></tr></thead><tbody>${rows.map((j) => `<tr><td><span class="job-id">${j.id} · ${j.ticks} ticks</span><span class="job-name" title="${esc(j.label)}">${esc(j.label)}</span></td><td><span class="group-name"><span class="group-dot ${j.group}"></span>${esc(sim.groups.find((g) => g.id === j.group)!.name.split(' ')[0])}</span></td><td>${j.cpu} / ${j.gpu}</td><td><span class="state-badge ${j.status.toLowerCase()}">${j.status.toLowerCase()}</span></td><td>${j.attempt || '—'}</td><td>${['QUEUED', 'RUNNING'].includes(j.status) ? `<button class="cancel-job" data-cancel="${j.id}" aria-label="Cancel ${j.id}">×</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No matching jobs. Try a different filter.</td></tr>'}</tbody></table></div><div class="queue-footer"><span>${jobs.length} matching jobs</span><button class="page-button" data-page="previous" ${page === 0 ? 'disabled' : ''}>Previous</button><span>${page + 1} / ${pages}</span><button class="page-button" data-page="next" ${page >= pages - 1 ? 'disabled' : ''}>Next</button></div>`;
}
function timeline() {
  const width = 900,
    label = 85,
    plot = width - label - 15,
    horizon = Math.max(16, sim.time + 6, ...sim.segments.map((s) => s.end ?? sim.time + 1)),
    height = sim.workers.length * 39 + 34,
    scale = plot / horizon;
  return `<section class="timeline-card"><div class="section-head"><h3>Worker allocation timeline</h3><span>Logical ticks</span></div><svg class="timeline-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Timeline of actual simulated worker reservations">${Array.from(
    { length: 6 },
    (_, i) => {
      const t = Math.round((i * horizon) / 5),
        x = label + t * scale;
      return `<line x1="${x}" y1="20" x2="${x}" y2="${height - 8}" class="timeline-grid"/><text x="${x}" y="12" text-anchor="middle">${t}</text>`;
    },
  ).join(
    '',
  )}${sim.workers.map((w, i) => `<text x="0" y="${i * 39 + 45}">${esc(w.id.replace('worker-', 'worker '))}</text>`).join('')}${sim.segments
    .map((s) => {
      const y = sim.workers.findIndex((w) => w.id === s.worker) * 39 + 28,
        x = label + s.start * scale,
        end = s.end ?? sim.time + 1,
        wide = Math.max(3, (end - s.start) * scale);
      return `<rect x="${x}" y="${y}" width="${wide}" height="25" rx="3" class="segment-${s.outcome === 'EXPIRED' || s.outcome === 'CANCELLED' ? 'failed' : s.group}"><title>${esc(s.job)} / ${esc(s.group)} / attempt ${s.attempt} / ${s.start}–${s.end ?? 'running'} / ${esc(s.outcome)}</title></rect>`;
    })
    .join(
      '',
    )}<line x1="${label + sim.time * scale}" x2="${label + sim.time * scale}" y1="20" y2="${height - 5}" class="timeline-current"/></svg><div class="timeline-legend">${sim.groups.map((g) => `<span><i class="group-dot ${g.id}"></i>${esc(g.name)}</span>`).join('')}<span><i class="group-dot segment-failed"></i>Expired / cancelled</span></div><p>Each bar is a recorded attempt. A crashed worker retains its reservation until lease expiry; a new attempt gets a new ownership token.</p></section>`;
}
function allocations() {
  return `<h3 class="view-title">Fair access, explicit budgets.</h3><p class="view-intro">Dispatch charges each group for its declared dominant resource share × duration ÷ weight. Lower accumulated service wins among eligible group heads. Quotas and worker slots are checked before every reservation.</p><div class="table-wrap"><table class="allocation-table"><thead><tr><th>RESEARCH GROUP</th><th>WEIGHT</th><th>SERVICE CHARGED</th><th>CPU / GPU QUOTA</th><th>RUNNING LIMIT</th></tr></thead><tbody>${sim.groups.map((g) => `<tr><td><span class="group-name"><i class="group-dot ${g.id}"></i>${esc(g.name)}</span></td><td><select data-weight="${g.id}" aria-label="${esc(g.name)} weight">${[0.5, 1, 2, 3].map((w) => `<option value="${w}" ${g.weight === w ? 'selected' : ''}>${w}×</option>`).join('')}</select></td><td>${g.served.toFixed(3)}</td><td>${g.cpuQuota} / ${g.gpuQuota}</td><td>${g.maxRunning}</td></tr>`).join('')}</tbody></table></div><div class="formula">charge = max(CPU / cluster CPU, GPU / cluster GPU) × duration / weight</div><p class="evidence-hint">This is nonpreemptive declared-cost scheduling, inspired by multi-resource fairness. It does not claim the formal properties of Dominant Resource Fairness. Service is charged at dispatch, including retries, and is not refunded on cancellation.</p>${timeline()}`;
}
function recovery() {
  return `<h3 class="view-title">Kill the worker. Keep the protocol.</h3><p class="view-intro">Stop a worker to halt its heartbeats. Advance at least three ticks, then try the old result. Expired ownership cannot commit, even if the same job has already been reassigned.</p><div class="worker-grid">${sim.workers
    .map((w) => {
      const j = sim.running().find((j) => j.worker === w.id);
      return `<div class="worker-card ${w.alive ? '' : 'offline'}"><div class="worker-head"><h4>${w.id}</h4><span>${w.alive ? 'heartbeats enabled' : 'heartbeats stopped'}</span></div><div class="worker-job">${j ? `${j.id} · ${esc(j.label)}` : 'No active reservation'}</div><div class="worker-lease">${j ? `Attempt ${j.attempt} · lease expires at t+${j.leaseUntil} · ${j.cpu} CPU / ${j.gpu} GPU` : 'Ready to request work when enabled'}</div><button class="button ${w.alive ? 'danger-button' : 'secondary'}" data-worker="${w.id}" data-action="${w.alive ? 'crash' : 'restart'}">${w.alive ? 'Stop worker' : 'Restart worker'}</button></div>`;
    })
    .join(
      '',
    )}</div><div class="recovery-instructions"><strong>Try the failure drill:</strong> stop a running worker, press Step tick three times, send its stale result, then restart it and finish the run. The backend repository also includes an actual OS-process kill/restart drill against the durable queue.</div><div class="recovery-actions"><button class="button secondary" id="stale-result" ${sim.stale.length ? '' : 'disabled'}>Send stale result</button><span>${sim.rejected} stale ${sim.rejected === 1 ? 'result' : 'results'} rejected</span></div>${timeline()}<div class="section-head"><h3>Recovery event log</h3><span>Latest 24 events</span></div>${eventLog()}`;
}
function eventLog() {
  return `<div class="event-log">${sim.events
    .slice(-24)
    .reverse()
    .map(
      (e) =>
        `<div class="event-line"><time>t+${e.time}</time><strong>${esc(e.kind)}</strong><span>${e.job ?? ''} ${esc(e.detail)}</span></div>`,
    )
    .join('')}</div>`;
}
function evidence() {
  let valid = true;
  try {
    assertCapacity(sim.running(), sim.groups, sim.config);
  } catch {
    valid = false;
  }
  return `<h3 class="view-title">Evidence behind the scheduler.</h3><p class="view-intro">This lab executes the same policy function used by the local queue. Every number below comes from a deterministic reference run or the current experiment.</p><div class="table-wrap"><table class="evidence-table"><thead><tr><th>POLICY</th><th>BOREAL FIRST WAIT</th><th>REFERENCE MAKESPAN</th></tr></thead><tbody>${race.map((r) => `<tr><td>${policies[r.policy]}</td><td>${fmt(r.groups.find((g) => g.id === 'boreal')?.firstStart ?? 0)} ticks</td><td>${r.makespan} ticks</td></tr>`).join('')}</tbody></table></div><div class="pass-line"><span></span>${valid ? 'PASS' : 'FAIL'} · Current cluster and group reservations stay within declared capacity.</div><div class="evidence-grid"><article class="evidence-card"><h4>Fairness is defined.</h4><p>Weighted mode selects the lowest accumulated declared dominant service among eligible group heads. FIFO preserves global queue order. The aging guard drains conflicting work for an old waiting job.</p></article><article class="evidence-card"><h4>Ownership is temporary.</h4><p>Heartbeats keep a lease alive. Expiry releases a reservation and requeues the job within an attempt budget. A fresh attempt receives a fresh token. Old completion is rejected before any result can change.</p></article><article class="evidence-card"><h4>Reservations are atomic.</h4><p>The local backend uses SQLite WAL and <code>BEGIN IMMEDIATE</code> to serialize selection, quota checks, token creation, and reservation. Independent-process tests exercise concurrent claims.</p></article><article class="evidence-card"><h4>Scope is visible.</h4><p>CPU/GPU values are logical admission units. The browser simulates time and workers. Local workers execute a small verified CPU challenge; there is no GPU execution, cgroup enforcement, or production cluster integration.</p></article></div><p class="evidence-hint"><a class="evidence-link" href="https://github.com/dk18234/strata-scheduler/blob/main/guide/VERIFICATION.md" target="_blank" rel="noopener">Read the verification record</a> · <a class="evidence-link" href="https://github.com/dk18234/strata-scheduler/blob/main/guide/LEARNING.md" target="_blank" rel="noopener">Follow the beginner learning path</a></p><div class="section-head"><h3>Current experiment events</h3><span>${sim.events.length} total</span></div>${eventLog()}`;
}
$('#play').addEventListener('click', () => {
  if (timer) {
    stop();
    return;
  }
  if (sim.complete()) reset();
  $('#play').textContent = 'Pause simulation';
  $('#play').setAttribute('aria-pressed', 'true');
  timer = setInterval(() => {
    try {
      sim.advance();
      render();
    } catch (e) {
      stop();
      notice(e instanceof Error ? e.message : 'Simulation stopped');
    }
  }, 400);
});
$('#step').addEventListener('click', () => {
  stop();
  try {
    sim.advance();
    render();
  } catch (e) {
    notice(String(e));
  }
});
$('#finish').addEventListener('click', () => {
  stop();
  try {
    sim.drain();
    render();
  } catch (e) {
    render();
    notice(e instanceof Error ? e.message : 'Could not finish the experiment');
  }
});
$('#reset').addEventListener('click', reset);
$('#policy').addEventListener('change', (event) => {
  source.config.policy = (event.target as HTMLSelectElement).value as Policy;
  reset();
});
document.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!target) return;
  const data = target.dataset;
  try {
    if (data.scenario) {
      source = structuredClone(examples.find((s) => s.id === data.scenario)!);
      view = source.id === 'failure' ? 'recovery' : 'queue';
      reset();
    } else if (data.view) {
      view = data.view;
      render();
    } else if (data.page) {
      page += data.page === 'next' ? 1 : -1;
      renderTable();
    } else if (data.cancel) {
      sim.cancel(data.cancel);
      render();
    } else if (data.worker) {
      if (data.action === 'crash') sim.crash(data.worker);
      else sim.restart(data.worker);
      render();
    } else if (target.id === 'stale-result') {
      const accepted = sim.lateResult();
      render();
      notice(
        accepted
          ? 'This lease is still current. Advance the clock until it expires, then try again.'
          : 'FENCED: the old token was rejected. Current ownership and reservations are unchanged.',
      );
    }
  } catch (e) {
    notice(e instanceof Error ? e.message : 'Operation could not be completed');
  }
});
$('#workspace').addEventListener('change', (event) => {
  const el = event.target as HTMLSelectElement;
  if (el.id === 'group-filter') {
    groupFilter = el.value;
    page = 0;
    renderTable();
  } else if (el.id === 'state-filter') {
    stateFilter = el.value;
    page = 0;
    renderTable();
  } else if (el.dataset.weight) {
    source.groups.find((g) => g.id === el.dataset.weight)!.weight = Number(el.value);
    reset();
  }
});
$('#workspace').addEventListener('focusin', (event) => {
  if (['group-filter', 'state-filter', 'job-search'].includes((event.target as HTMLElement).id))
    stop();
});
$('#workspace').addEventListener('input', (event) => {
  if ((event.target as HTMLElement).id === 'job-search') {
    search = (event.target as HTMLInputElement).value;
    page = 0;
    renderTable();
  }
});
$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(sim.report(), null, 2) + '\n'], {
      type: 'application/json',
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = 'strata-experiment.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const dialog = $<HTMLDialogElement>('#add-dialog');
$('#add-open').addEventListener('click', () => {
  stop();
  $('#job-group').innerHTML = sim.groups
    .map((g) => `<option value="${g.id}">${esc(g.name)}</option>`)
    .join('');
  $('#job-cpu').setAttribute('max', String(sim.config.cpu));
  $('#job-gpu').setAttribute('max', String(sim.config.gpu));
  $('#form-error').hidden = true;
  dialog.showModal();
});
$('#add-close').addEventListener('click', () => dialog.close());
$('#add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(event.target as HTMLFormElement);
  try {
    sim.submit({
      label: String(data.get('label')),
      group: String(data.get('group')),
      cpu: Number(data.get('cpu')),
      gpu: Number(data.get('gpu')),
      ticks: Number(data.get('ticks')),
    });
    sim.dispatch();
    dialog.close();
    render();
    notice(
      'Job added at the current tick. Reference policy comparisons retain the original workload.',
    );
  } catch (e) {
    $('#form-error').textContent = e instanceof Error ? e.message : 'Invalid job';
    $('#form-error').hidden = false;
  }
});
render();
