import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
const STATE = 'YL_MONITOR_STATE_V1';
const UID = '4034124084959907503';
function harness() {
  const storage = new Map();
  const env = {now: Date.parse('2026-10-29T13:00:00Z'), quota: 100,
    triggers: [], mails: [], requests: [], logs: [], healthy: true,
    responseCode: 200, body: null, stateWrites: 0, failWriteAt: null,
    sendThrows: false, busy: false};
  const trigger = {getHandlerFunction: () => 'ylMonitorClock',
    getUniqueId: () => UID, getTriggerSource: () => 'CLOCK'};
  const props = {getProperty: k => storage.get(k) ?? null,
    setProperty(k, value) {
      if (k === STATE && ++env.stateWrites === env.failWriteAt) throw new Error('provider write failure');
      storage.set(k, value); return this;
    }};
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [env.now])); }
    static now() { return env.now; }
  }
  const builder = {timeBased() { return this; }, everyMinutes(n) {
    assert.equal(n, 5); return this;
  }, create() { env.triggers.push(trigger); return trigger; }};
  const context = vm.createContext({Date: Clock,
    console: {log: s => env.logs.push(JSON.parse(s))},
    PropertiesService: {getScriptProperties: () => props},
    LockService: {getScriptLock: () => ({tryLock: () => !env.busy, releaseLock() {}})},
    ScriptApp: {AuthMode: {FULL: 'FULL'}, TriggerSource: {CLOCK: 'CLOCK'},
      getScriptId: () => 'synthetic-project', getProjectTriggers: () => env.triggers,
      newTrigger(name) { assert.equal(name, 'ylMonitorClock'); return builder; }},
    MailApp: {getRemainingDailyQuota: () => env.quota,
      sendEmail(message) { env.mails.push(JSON.parse(JSON.stringify(message)));
        if (env.sendThrows) throw new Error('upstream error must not leak'); }},
    UrlFetchApp: {fetch(url, options) {
      env.requests.push({url, options});
      const body = env.body ?? Object.fromEntries(['site','schema','payments','jobs','monitor'].map(k => [k,env.healthy]));
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return {getResponseCode: () => env.responseCode,
        getContent: () => Buffer.from(text), getContentText: () => text};
    }}
  });
  vm.runInContext(source, context);
  const api = vm.runInContext('({setupMonitor,ylMonitorClock,readMonitorStatus})', context);
  return {env, storage, api, state: () => JSON.parse(storage.get(STATE) || 'null'),
    setup() { api.setupMonitor(); env.stateWrites = 0; },
    tick() { env.now += 300000; return api.ylMonitorClock({triggerUid: UID, authMode: 'FULL'}); }};
}

test('setup is idempotent, sends nothing, and creates one five-minute clock', () => {
  const h = harness(); h.setup(); h.setup();
  assert.equal(h.env.triggers.length, 1); assert.equal(h.env.mails.length, 0);
  assert.equal(h.api.readMonitorStatus().state.automaticRuns, 0);
});
test('manual and wrong-trigger calls cannot count as automatic', () => {
  const h = harness(); h.setup();
  for (const e of [undefined, {}, {triggerUid:'wrong',authMode:'FULL'}, {triggerUid:UID,authMode:'LIMITED'}])
    assert.throws(() => h.api.ylMonitorClock(e), /configured_clock_event_required/);
  assert.equal(h.api.readMonitorStatus().state.automaticRuns, 0);
  assert.equal(h.env.requests.length, 0); assert.equal(h.env.mails.length, 0);
});
test('first clock sends one fixed connection notice; later healthy clocks are quiet', () => {
  const h = harness(); h.setup(); h.tick(); h.tick(); h.tick();
  assert.equal(h.state().automaticRuns, 3); assert.equal(h.env.mails.length, 1);
  assert.equal(h.env.mails[0].to, 'contact@cgcorp.io');
  assert.match(h.env.mails[0].subject, /첫 자동 실행/);
  assert.equal(h.state().connectionAccepted, true);
  assert.equal(h.api.readMonitorStatus().audit.every(a => a.source === 'clock' && a.triggerUid === UID), true);
});
test('two failed observations notify once; recovery notifies once', () => {
  const h = harness(); h.setup(); h.tick(); h.env.healthy = false;
  h.tick(); assert.equal(h.env.mails.length, 1);
  h.tick(); h.tick(); assert.equal(h.env.mails.length, 2);
  h.env.healthy = true; h.tick(); h.tick();
  assert.equal(h.env.mails.length, 3); assert.match(h.env.mails[2].subject, /정상 복구/);
});
test('a transient failed check produces no outage notice', () => {
  const h = harness(); h.setup(); h.tick(); h.env.healthy = false; h.tick();
  h.env.healthy = true; h.tick(); assert.equal(h.env.mails.length, 1);
});
test('wrong HTTP, malformed JSON, extra fields and non-boolean checks fail closed', () => {
  for (const patch of [{responseCode:302}, {responseCode:503}, {body:'private html'},
    {body:{site:true}}, {body:{site:true,schema:true,payments:true,jobs:true,monitor:1}},
    {body:{site:true,schema:true,payments:true,jobs:true,monitor:true,private:'rejected'}}]) {
    const h = harness(); h.setup(); Object.assign(h.env, patch); h.tick();
    assert.equal(h.api.readMonitorStatus().audit[0].observation, 'down');
  }
});
test('transport uses only fixed HTTPS origin, TLS validation, and no redirects or key', () => {
  const h = harness(); h.setup(); h.tick();
  const r = h.env.requests[0]; assert.equal(r.url, 'https://y-learner.com/api/public/status');
  assert.equal(r.options.followRedirects, false); assert.equal(r.options.validateHttpsCertificates, true);
  assert.equal('Authorization' in r.options.headers, false);
});
test('persisted attempt prevents a duplicate after an ambiguous provider result', () => {
  const h = harness(); h.setup(); h.env.sendThrows = true;
  assert.throws(() => h.tick(), /mail_delivery_requires_review/);
  h.env.sendThrows = false;
  assert.throws(() => h.tick(), /mail_delivery_requires_review/);
  assert.equal(h.env.mails.length, 1); assert.equal(h.state().pending.attempted, true);
});
test('a lost state-write acknowledgement after send cannot cause resend', () => {
  const h = harness(); h.setup(); h.env.failWriteAt = 3;
  assert.throws(() => h.tick(), /monitor_execution_failed/);
  h.env.failWriteAt = null;
  assert.throws(() => h.tick(), /mail_delivery_requires_review/);
  assert.equal(h.env.mails.length, 1);
});
test('no message is sent if pre-send state persistence fails', () => {
  const h = harness(); h.setup(); h.env.failWriteAt = 2;
  assert.throws(() => h.tick(), /monitor_execution_failed/);
  assert.equal(h.env.mails.length, 0);
});
test('quota exhaustion queues without sending; restoring quota permits one attempt', () => {
  const h = harness(); h.setup(); h.env.quota = 0;
  assert.throws(() => h.tick(), /mail_quota_reached/);
  assert.equal(h.env.mails.length, 0); assert.equal(h.state().pending.attempted, false);
  h.env.quota = 1; h.tick(); h.tick(); assert.equal(h.env.mails.length, 1);
});
test('an unattempted stale outage is cancelled after recovery', () => {
  const h = harness(); h.setup(); h.tick(); h.env.quota = 0; h.env.healthy = false;
  h.tick(); assert.throws(() => h.tick(), /mail_quota_reached/);
  h.env.healthy = true; h.env.quota = 10; h.tick();
  assert.equal(h.env.mails.length, 1); assert.equal(h.state().pending, null);
});
test('invalid persisted recipient/body fields are rejected', () => {
  const h = harness(); h.setup(); h.tick();
  h.storage.set(STATE, JSON.stringify({...h.state(),to:'attacker@example.test'}));
  assert.throws(() => h.tick(), /invalid_monitor_state/); assert.equal(h.env.mails.length, 1);
});
test('local daily and monthly attempt caps prevent additional sends', () => {
  for (const [field,value] of [['dailyAttempts',10],['monthlyAttempts',300]]) {
    const h = harness(); h.setup(); h.tick(); h.env.healthy = false; h.tick();
    h.storage.set(STATE, JSON.stringify({...h.state(),[field]:value}));
    assert.throws(() => h.tick(), /mail_quota_reached/); assert.equal(h.env.mails.length, 1);
  }
});
test('audit is bounded and read-only diagnostics do not count as scheduled runs', () => {
  const h = harness(); h.setup(); for (let i=0;i<20;i++) h.tick();
  const r = h.api.readMonitorStatus(); assert.equal(r.audit.length,12);
  assert.equal(r.state.automaticRuns,20); h.api.readMonitorStatus();
  assert.equal(h.state().automaticRuns,20); assert.equal(h.env.mails.length,1);
  assert.ok(Buffer.byteLength(h.storage.get('YL_MONITOR_AUDIT_V1'))<9000);
});
