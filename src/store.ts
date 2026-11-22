import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertCapacity,
  cost,
  defaultGroups,
  InputError,
  validateConfig,
  validateJob,
  integer,
  type Config,
  type Group,
  type Job,
  type JobInput,
} from './core/model.js';
import { selectJob } from './core/planner.js';
import { expectedResult } from './workload.js';
export interface StoreConfig extends Config {
  tickMs: number;
  leaseMs: number;
  graceMs: number;
  maxAttempts: number;
}
export const DEFAULT_STORE: StoreConfig = {
  cpu: 8,
  gpu: 2,
  workers: 4,
  agingTicks: 8,
  policy: 'guard',
  tickMs: 250,
  leaseMs: 1500,
  graceMs: 1000,
  maxAttempts: 3,
};
type Row = Record<string, string | number | null>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (message: string, code = 'FENCED') => ({ error: message, code });
export class QueueStore {
  readonly db: DatabaseSync;
  readonly config: StoreConfig;
  readonly epoch: number;
  constructor(path: string, config: StoreConfig = DEFAULT_STORE, now = Date.now()) {
    validateConfig(config);
    integer(config.tickMs, 20, 10000, 'Tick milliseconds');
    integer(config.leaseMs, 100, 60000, 'Lease milliseconds');
    integer(config.graceMs, 100, 30000, 'Runtime grace');
    integer(config.maxAttempts, 1, 5, 'Attempt limit');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,weight REAL NOT NULL,cpu_quota INTEGER NOT NULL,gpu_quota INTEGER NOT NULL,max_running INTEGER NOT NULL,served REAL NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,label TEXT NOT NULL,group_id TEXT NOT NULL REFERENCES groups(id),cpu INTEGER NOT NULL CHECK(cpu>0),gpu INTEGER NOT NULL CHECK(gpu>=0),ticks INTEGER NOT NULL CHECK(ticks>0),submitted REAL NOT NULL,status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),attempt INTEGER NOT NULL DEFAULT 0,worker TEXT,token_hash TEXT,lease_until REAL,deadline REAL,started REAL,ended REAL,result TEXT);
  CREATE INDEX IF NOT EXISTS queue_order ON jobs(status,submitted,seq);
  CREATE TABLE IF NOT EXISTS reservations(job_id TEXT PRIMARY KEY REFERENCES jobs(id),cpu INTEGER NOT NULL,gpu INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS attempts(job_id TEXT NOT NULL REFERENCES jobs(id),attempt INTEGER NOT NULL,worker TEXT NOT NULL,token_hash TEXT NOT NULL,status TEXT NOT NULL,started REAL NOT NULL,ended REAL,result TEXT,PRIMARY KEY(job_id,attempt));
  CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY,last_seen REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,ids TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,at REAL NOT NULL,kind TEXT NOT NULL,job_id TEXT,worker TEXT,detail TEXT NOT NULL);`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('config') as
        | Row
        | undefined;
      if (existing) {
        this.config = JSON.parse(String(existing.value));
        if (
          JSON.stringify(Object.entries(this.config).sort()) !==
          JSON.stringify(Object.entries(config).sort())
        )
          throw new InputError(
            'Persisted queue configuration differs. Reopen with the same settings; use a new database for another configuration.',
          );
        this.epoch = Number(
          (this.db.prepare('SELECT value FROM metadata WHERE key=?').get('epoch') as Row).value,
        );
      } else {
        this.config = structuredClone(config);
        this.epoch = now;
        this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('config', JSON.stringify(config));
        this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('epoch', String(now));
        this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('schema', '1');
        for (const g of defaultGroups(config))
          this.db
            .prepare('INSERT INTO groups VALUES(?,?,?,?,?,?,?)')
            .run(g.id, g.name, g.weight, g.cpuQuota, g.gpuQuota, g.maxRunning, g.served);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw e;
    }
  }
  private tx<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      this.check();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  private event(at: number, kind: string, detail: string, job?: string, worker?: string) {
    this.db
      .prepare('INSERT INTO events(at,kind,job_id,worker,detail) VALUES(?,?,?,?,?)')
      .run(at, kind, job ?? null, worker ?? null, detail);
    this.db
      .prepare('DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id),0)-10000 FROM events)')
      .run();
  }
  groups(): Group[] {
    return (this.db.prepare('SELECT * FROM groups ORDER BY id').all() as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      weight: Number(r.weight),
      cpuQuota: Number(r.cpu_quota),
      gpuQuota: Number(r.gpu_quota),
      maxRunning: Number(r.max_running),
      served: Number(r.served),
    }));
  }
  private job(r: Row): Job {
    return {
      id: String(r.id),
      seq: Number(r.seq),
      label: String(r.label),
      group: String(r.group_id),
      cpu: Number(r.cpu),
      gpu: Number(r.gpu),
      ticks: Number(r.ticks),
      submitted: (Number(r.submitted) - this.epoch) / this.config.tickMs,
      status: r.status as Job['status'],
      attempt: Number(r.attempt),
      ...(r.started !== null
        ? { started: (Number(r.started) - this.epoch) / this.config.tickMs }
        : {}),
      ...(r.ended !== null ? { ended: (Number(r.ended) - this.epoch) / this.config.tickMs } : {}),
      ...(r.worker !== null ? { worker: String(r.worker) } : {}),
      ...(r.lease_until !== null
        ? { leaseUntil: (Number(r.lease_until) - this.epoch) / this.config.tickMs }
        : {}),
    };
  }
  private jobs(): Job[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY seq').all() as Row[]).map((r) =>
      this.job(r),
    );
  }
  private check() {
    const running = this.jobs().filter((j) => j.status === 'RUNNING');
    assertCapacity(running, this.groups(), this.config);
    const reserved = this.db
      .prepare(
        'SELECT COUNT(*) n,COALESCE(SUM(cpu),0) cpu,COALESCE(SUM(gpu),0) gpu FROM reservations',
      )
      .get() as Row;
    const mismatch = this.db
      .prepare(
        "SELECT COUNT(*) n FROM reservations r LEFT JOIN jobs j ON j.id=r.job_id WHERE j.status!='RUNNING' OR r.cpu!=j.cpu OR r.gpu!=j.gpu",
      )
      .get() as Row;
    if (Number(mismatch.n)) throw new Error('Per-job reservation invariant violated');
    if (
      Number(reserved.n) !== running.length ||
      Number(reserved.cpu) !== running.reduce((s, j) => s + j.cpu, 0) ||
      Number(reserved.gpu) !== running.reduce((s, j) => s + j.gpu, 0)
    )
      throw new Error('Reservation ledger does not match active jobs');
  }
  submit(inputs: unknown[], key: string, now = Date.now()) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 200)
      throw new InputError('Submit 1–200 jobs at once');
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key))
      throw new InputError('Provide a 1–80 character Idempotency-Key');
    const normalized = inputs.map((i) => validateJob(i, this.config, this.groups())),
      fingerprint = hash(
        JSON.stringify(
          normalized.map((j, i) => ({
            ...j,
            submitted: (inputs[i] as JobInput).submitted === undefined ? 'immediate' : j.submitted,
          })),
        ),
      );
    return this.tx(() => {
      const previous = this.db.prepare('SELECT * FROM requests WHERE key=?').get(key) as
        | Row
        | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new InputError(
            'Idempotency key was already used for another payload',
            'IDEMPOTENCY_CONFLICT',
            409,
          );
        return { ids: JSON.parse(String(previous.ids)) as string[], duplicate: true };
      }
      const count = Number((this.db.prepare('SELECT COUNT(*) n FROM jobs').get() as Row).n);
      if (count + normalized.length > 1000)
        throw new InputError(
          'Queue history limit is 1000 jobs; use a new local database for another experiment',
          'QUEUE_LIMIT',
          429,
        );
      const ids = normalized.map((j, i) => {
        const id = 'job_' + randomUUID();
        const original = inputs[i] as JobInput;
        const submitted =
          original.submitted === undefined ? now : this.epoch + j.submitted! * this.config.tickMs;
        this.db
          .prepare(
            'INSERT INTO jobs(id,label,group_id,cpu,gpu,ticks,submitted,status) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(id, j.label, j.group, j.cpu, j.gpu, j.ticks, submitted, 'QUEUED');
        this.event(now, 'SUBMITTED', j.label, id);
        return id;
      });
      this.db
        .prepare('INSERT INTO requests VALUES(?,?,?)')
        .run(key, fingerprint, JSON.stringify(ids));
      return { ids, duplicate: false };
    });
  }
  private expire(now: number) {
    const expired = this.db
      .prepare("SELECT * FROM jobs WHERE status='RUNNING' AND (lease_until<=? OR deadline<=?)")
      .all(now, now) as Row[];
    for (const r of expired) {
      const terminal = Number(r.attempt) >= this.config.maxAttempts;
      this.db.prepare('DELETE FROM reservations WHERE job_id=?').run(String(r.id));
      this.db
        .prepare('UPDATE attempts SET status=?,ended=? WHERE job_id=? AND attempt=?')
        .run('EXPIRED', now, String(r.id), Number(r.attempt));
      this.db
        .prepare(
          'UPDATE jobs SET status=?,worker=NULL,token_hash=NULL,lease_until=NULL,deadline=NULL,ended=? WHERE id=?',
        )
        .run(terminal ? 'FAILED' : 'QUEUED', terminal ? now : null, String(r.id));
      this.event(
        now,
        terminal ? 'FAILED' : 'LEASE_EXPIRED',
        terminal
          ? 'Attempt budget exhausted.'
          : 'Reservation released atomically; expired attempt cannot commit.',
        String(r.id),
        String(r.worker),
      );
    }
    return expired.map((r) => String(r.id));
  }
  recover(now = Date.now()) {
    return this.tx(() => this.expire(now));
  }
  claim(worker: string, now = Date.now()) {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(worker)) throw new InputError('Invalid worker ID');
    return this.tx(() => {
      this.expire(now);
      if (this.db.prepare("SELECT id FROM jobs WHERE worker=? AND status='RUNNING'").get(worker))
        throw new InputError('This worker already owns an active attempt', 'WORKER_BUSY', 409);
      const workers = Number((this.db.prepare('SELECT COUNT(*) n FROM workers').get() as Row).n);
      if (workers >= 100 && !this.db.prepare('SELECT id FROM workers WHERE id=?').get(worker))
        throw new InputError('Worker identity limit reached', 'WORKER_LIMIT', 429);
      this.db
        .prepare(
          'INSERT INTO workers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen',
        )
        .run(worker, now);
      const jobs = this.jobs(),
        groups = this.groups(),
        decision = selectJob(
          jobs,
          jobs.filter((j) => j.status === 'RUNNING'),
          groups,
          this.config,
          (now - this.epoch) / this.config.tickMs,
        );
      if (!decision.job) return { job: null, reason: decision.reason };
      const j = decision.job,
        token = randomUUID() + randomUUID(),
        digest = hash(token),
        deadline = now + j.ticks * this.config.tickMs + this.config.graceMs,
        lease = Math.min(now + this.config.leaseMs, deadline),
        attempt = j.attempt + 1;
      this.db
        .prepare(
          "UPDATE jobs SET status='RUNNING',attempt=?,worker=?,token_hash=?,lease_until=?,deadline=?,started=?,ended=NULL WHERE id=?",
        )
        .run(attempt, worker, digest, lease, deadline, now, j.id);
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(j.id, j.cpu, j.gpu);
      this.db
        .prepare(
          'INSERT INTO attempts(job_id,attempt,worker,token_hash,status,started) VALUES(?,?,?,?,?,?)',
        )
        .run(j.id, attempt, worker, digest, 'RUNNING', now);
      this.db
        .prepare('UPDATE groups SET served=served+? WHERE id=?')
        .run(cost(j, groups.find((g) => g.id === j.group)!, this.config), j.group);
      this.event(now, 'DISPATCHED', decision.reason, j.id, worker);
      return {
        job: {
          ...j,
          status: 'RUNNING' as const,
          attempt,
          worker,
          started: (now - this.epoch) / this.config.tickMs,
        },
        token,
        leaseUntil: lease,
        deadline,
        runMs: j.ticks * this.config.tickMs,
        heartbeatMs: Math.max(25, Math.floor(this.config.leaseMs / 3)),
        reason: decision.reason,
      };
    });
  }
  heartbeat(id: string, token: string, now = Date.now()) {
    const result = this.tx(() => {
      this.expire(now);
      const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
      if (!r || r.status !== 'RUNNING' || !same(String(r.token_hash), hash(token))) {
        this.event(now, 'STALE_HEARTBEAT_REJECTED', 'Ownership token is not current.', id);
        return fail('Attempt ownership has expired or changed');
      }
      const lease = Math.min(now + this.config.leaseMs, Number(r.deadline));
      this.db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(lease, id);
      this.db.prepare('UPDATE workers SET last_seen=? WHERE id=?').run(now, String(r.worker));
      return { leaseUntil: lease };
    });
    if ('error' in result) throw new InputError(result.error, result.code, 409);
    return result;
  }
  complete(id: string, token: string, result: string, now = Date.now()) {
    const outcome = this.tx(() => {
      this.expire(now);
      const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined,
        digest = hash(token);
      if (r?.status === 'SUCCEEDED' && same(String(r.token_hash), digest)) {
        if (r.result !== result)
          return fail('Repeated completion has a different result', 'RESULT_CONFLICT');
        return { duplicate: true, result: String(r.result) };
      }
      if (!r || r.status !== 'RUNNING' || !same(String(r.token_hash), digest)) {
        this.event(
          now,
          'STALE_RESULT_REJECTED',
          'A stale ownership token cannot commit a result.',
          id,
        );
        return fail('Attempt ownership has expired or changed');
      }
      if (!/^[a-f0-9]{64}$/.test(result)) {
        this.event(
          now,
          'INVALID_RESULT_REJECTED',
          'Result must be a SHA-256 hexadecimal value.',
          id,
        );
        return fail('Invalid checksum result', 'INVALID_RESULT');
      }
      if (!same(expectedResult(this.job(r)), result)) {
        this.event(
          now,
          'INVALID_RESULT_REJECTED',
          'Synthetic workload checksum does not match the assigned challenge.',
          id,
        );
        return fail('Checksum does not match the assigned workload', 'INVALID_RESULT');
      }
      this.db
        .prepare(
          "UPDATE jobs SET status='SUCCEEDED',ended=?,result=?,lease_until=NULL,deadline=NULL WHERE id=?",
        )
        .run(now, result, id);
      this.db
        .prepare(
          "UPDATE attempts SET status='SUCCEEDED',ended=?,result=? WHERE job_id=? AND attempt=?",
        )
        .run(now, result, id, Number(r.attempt));
      this.db.prepare('DELETE FROM reservations WHERE job_id=?').run(id);
      this.event(
        now,
        'COMPLETED',
        'Current attempt committed once; reservation released.',
        id,
        String(r.worker),
      );
      return { duplicate: false, result };
    });
    if ('error' in outcome) throw new InputError(outcome.error, outcome.code, 409);
    return outcome;
  }
  cancel(id: string, now = Date.now()) {
    return this.tx(() => {
      this.expire(now);
      const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
      if (!r) throw new InputError('Unknown job', 'NOT_FOUND', 404);
      if (!['QUEUED', 'RUNNING'].includes(String(r.status))) return { changed: false };
      this.db
        .prepare(
          "UPDATE jobs SET status='CANCELLED',ended=?,token_hash=NULL,lease_until=NULL,deadline=NULL WHERE id=?",
        )
        .run(now, id);
      this.db.prepare('DELETE FROM reservations WHERE job_id=?').run(id);
      if (r.status === 'RUNNING')
        this.db
          .prepare("UPDATE attempts SET status='CANCELLED',ended=? WHERE job_id=? AND attempt=?")
          .run(now, id, Number(r.attempt));
      this.event(now, 'CANCELLED', 'Current ownership revoked; reservation released.', id);
      return { changed: true };
    });
  }
  snapshot(now = Date.now()) {
    // A deferred transaction gives readers one coherent SQLite snapshot.
    this.db.exec('BEGIN');
    try {
      this.check();
      const jobs = this.jobs(),
        groups = this.groups(),
        events = (
          this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1000').all() as Row[]
        )
          .reverse()
          .map((r) => ({
            id: Number(r.id),
            time: (Number(r.at) - this.epoch) / this.config.tickMs,
            kind: String(r.kind),
            job: r.job_id ?? undefined,
            worker: r.worker ?? undefined,
            detail: String(r.detail),
          }));
      const attempts = this.db
        .prepare(
          'SELECT job_id,attempt,worker,status,started,ended,result FROM attempts ORDER BY job_id,attempt',
        )
        .all();
      const workers = (this.db.prepare('SELECT * FROM workers ORDER BY id').all() as Row[]).map(
        (w) => ({
          id: String(w.id),
          lastSeen: Number(w.last_seen),
          recent: now - Number(w.last_seen) < this.config.leaseMs,
        }),
      );
      const value = {
        tool: 'Strata',
        version: '1.0.0',
        mode: 'durable local queue',
        time: (now - this.epoch) / this.config.tickMs,
        config: this.config,
        groups,
        jobs,
        attempts,
        events,
        workers,
        reservations: this.db.prepare('SELECT * FROM reservations').all(),
        scope:
          'Logical CPU/GPU admission budgets; local synthetic workloads, no GPU execution or OS resource isolation.',
      };
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
