/** Private standalone Apps Script. No web deployment, API keys or paid services. */
const YL_MONITOR = Object.freeze({
  version: 'yl-google-monitor-2026-10-29-v1',
  url: 'https://y-learner.com/api/public/status',
  recipient: 'contact@cgcorp.io',
  handler: 'ylMonitorClock',
  intervalMinutes: 5,
  maxDailyAttempts: 10,
  maxMonthlyAttempts: 300,
  stateKey: 'YL_MONITOR_STATE_V1',
  configKey: 'YL_MONITOR_CONFIG_V1',
  auditKey: 'YL_MONITOR_AUDIT_V1'
});

/** Install exactly one clock; preserve state on retries. Sends no manual test. */
function setupMonitor() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('monitor_busy');
  try {
    const props = PropertiesService.getScriptProperties();
    const triggers = ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getHandlerFunction() === YL_MONITOR.handler;
    });
    if (triggers.length > 1) throw new Error('duplicate_monitor_triggers');
    const quota = MailApp.getRemainingDailyQuota();
    if (quota < 1) throw new Error('mail_quota_reached');
    loadMonitorState_(props);
    const trigger = triggers[0] || ScriptApp.newTrigger(YL_MONITOR.handler)
      .timeBased().everyMinutes(YL_MONITOR.intervalMinutes).create();
    if (trigger.getTriggerSource() !== ScriptApp.TriggerSource.CLOCK)
      throw new Error('clock_trigger_required');
    props.setProperty(YL_MONITOR.configKey, JSON.stringify({
      version: YL_MONITOR.version, triggerUid: String(trigger.getUniqueId())
    }));
    console.log(JSON.stringify({setup: 'ready', version: YL_MONITOR.version,
      triggerUid: String(trigger.getUniqueId()), intervalMinutes: 5,
      recipient: YL_MONITOR.recipient, remainingDailyRecipients: quota,
      automaticRuns: loadMonitorState_(props).automaticRuns, manualMailSent: false}));
  } finally { lock.releaseLock(); }
}

/** Only a genuine configured time-driven event is counted as automatic. */
function ylMonitorClock(e) {
  const props = PropertiesService.getScriptProperties();
  const config = JSON.parse(props.getProperty(YL_MONITOR.configKey) || '{}');
  if (!e || !e.triggerUid || String(e.triggerUid) !== config.triggerUid ||
      e.authMode !== ScriptApp.AuthMode.FULL || config.version !== YL_MONITOR.version)
    throw new Error('configured_clock_event_required');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('monitor_busy');
  const started = new Date().toISOString();
  const entry = {at: started, source: 'clock', triggerUid: String(e.triggerUid),
    version: YL_MONITOR.version, run: null, observation: null, checks: null,
    mail: 'none', error: null};
  try {
    const state = loadMonitorState_(props);
    const result = observePublicStatus_();
    entry.observation = result.healthy ? 'up' : 'down';
    entry.checks = result.checks;
    state.automaticRuns += 1;
    state.firstAutomaticAt = state.firstAutomaticAt || started;
    state.lastAutomaticAt = started;
    entry.run = state.automaticRuns;
    const day = started.slice(0, 10), month = day.slice(0, 7);
    if (state.day !== day) { state.day = day; state.dailyAttempts = 0; }
    if (state.month !== month) { state.month = month; state.monthlyAttempts = 0; }
    if (result.healthy) { state.failures = 0; state.status = 'up'; }
    else { state.failures = Math.min(2, state.failures + 1);
      if (state.failures === 2) state.status = 'down'; }

    // Coalesce an unattempted stale notice; never retry an ambiguous send.
    if (!state.pending || !state.pending.attempted) {
      let kind = !state.connectionAccepted ? 'connection' :
        state.status === 'down' && state.lastNotified !== 'down' ? 'down' :
        state.status === 'up' && state.lastNotified === 'down' ? 'recovery' : null;
      if (!kind) state.pending = null;
      else if (!state.pending || state.pending.kind !== kind) {
        state.sequence += 1;
        state.pending = {kind: kind, sequence: state.sequence,
          createdAt: started, attempted: false};
      }
    }
    saveMonitorState_(props, state);
    if (state.pending) {
      if (state.pending.attempted) throw new Error('mail_delivery_requires_review');
      if (state.dailyAttempts >= YL_MONITOR.maxDailyAttempts ||
          state.monthlyAttempts >= YL_MONITOR.maxMonthlyAttempts ||
          MailApp.getRemainingDailyQuota() < 1) throw new Error('mail_quota_reached');
      const kind = state.pending.kind;
      state.pending.attempted = true;
      state.dailyAttempts += 1; state.monthlyAttempts += 1;
      // Persist BEFORE MailApp. If its acknowledgement is lost, stop for review.
      saveMonitorState_(props, state);
      try { MailApp.sendEmail(monitorMail_(state.pending, result.checks)); }
      catch (_) { throw new Error('mail_delivery_requires_review'); }
      entry.mail = kind + '_accepted';
      if (kind === 'connection') {
        state.connectionAccepted = true; state.connectionAcceptedAt = started;
      } else state.lastNotified = kind === 'down' ? 'down' : 'up';
      state.mailAccepted += 1; state.pending = null;
      saveMonitorState_(props, state);
    }
  } catch (error) {
    const known = ['mail_delivery_requires_review', 'mail_quota_reached',
      'invalid_monitor_state'];
    entry.error = known.indexOf(error.message) >= 0 ? error.message : 'monitor_execution_failed';
    throw new Error(entry.error);
  } finally {
    try {
      const previous = JSON.parse(props.getProperty(YL_MONITOR.auditKey) || '[]');
      props.setProperty(YL_MONITOR.auditKey, JSON.stringify(previous.concat([entry]).slice(-12)));
      console.log(JSON.stringify(entry));
    } finally { lock.releaseLock(); }
  }
}

/** Read-only diagnostics; does not increment automaticRuns or send email. */
function readMonitorStatus() {
  const props = PropertiesService.getScriptProperties();
  const report = {version: YL_MONITOR.version, projectId: ScriptApp.getScriptId(),
    url: YL_MONITOR.url, recipient: YL_MONITOR.recipient, intervalMinutes: 5,
    state: loadMonitorState_(props),
    audit: JSON.parse(props.getProperty(YL_MONITOR.auditKey) || '[]'),
    triggers: ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getHandlerFunction() === YL_MONITOR.handler;
    }).map(function(t) { return {handler: t.getHandlerFunction(),
      uid: String(t.getUniqueId()), source: String(t.getTriggerSource())}; })};
  console.log(JSON.stringify(report));
  return report;
}

function loadMonitorState_(props) {
  const empty = {version: 1, status: 'unknown', failures: 0, automaticRuns: 0,
    firstAutomaticAt: null, lastAutomaticAt: null, connectionAccepted: false,
    connectionAcceptedAt: null, lastNotified: 'up', sequence: 0, mailAccepted: 0,
    day: '', month: '', dailyAttempts: 0, monthlyAttempts: 0, pending: null};
  const raw = props.getProperty(YL_MONITOR.stateKey);
  const s = raw ? JSON.parse(raw) : empty;
  if (!s || Array.isArray(s) || Object.keys(s).sort().join(',') !== Object.keys(empty).sort().join(',') ||
      s.version !== 1 || ['unknown', 'up', 'down'].indexOf(s.status) < 0 ||
      ['up', 'down'].indexOf(s.lastNotified) < 0 || typeof s.connectionAccepted !== 'boolean' ||
      !['failures', 'automaticRuns', 'sequence', 'mailAccepted', 'dailyAttempts', 'monthlyAttempts']
        .every(function(k) { return Number.isSafeInteger(s[k]) && s[k] >= 0; }) ||
      s.failures > 2 || !/^$|^\d{4}-\d{2}-\d{2}$/.test(s.day) ||
      !/^$|^\d{4}-\d{2}$/.test(s.month)) throw new Error('invalid_monitor_state');
  if (s.pending && (Object.keys(s.pending).sort().join(',') !== 'attempted,createdAt,kind,sequence' ||
      ['connection', 'down', 'recovery'].indexOf(s.pending.kind) < 0 ||
      s.pending.sequence !== s.sequence || typeof s.pending.attempted !== 'boolean' ||
      !Number.isFinite(Date.parse(s.pending.createdAt)))) throw new Error('invalid_monitor_state');
  return s;
}

function saveMonitorState_(props, state) {
  props.setProperty(YL_MONITOR.stateKey, JSON.stringify(state));
}

function observePublicStatus_() {
  const names = ['site', 'schema', 'payments', 'jobs', 'monitor'];
  try {
    const response = UrlFetchApp.fetch(YL_MONITOR.url, {method: 'get',
      followRedirects: false, validateHttpsCertificates: true,
      muteHttpExceptions: true, headers: {Accept: 'application/json'}});
    if (response.getResponseCode() !== 200 || response.getContent().length > 65536)
      return {healthy: false, checks: null};
    const body = JSON.parse(response.getContentText());
    const valid = body && !Array.isArray(body) && typeof body === 'object' &&
      Object.keys(body).sort().join(',') === names.slice().sort().join(',') &&
      names.every(function(k) { return typeof body[k] === 'boolean'; });
    return {healthy: !!valid && names.every(function(k) { return body[k] === true; }),
      checks: valid ? body : null};
  } catch (_) { return {healthy: false, checks: null}; }
}

function monitorMail_(event, checks) {
  const subject = {connection: '[Y Learner] 무료 장애 감시 첫 자동 실행 확인',
    down: '[Y Learner] 운영 상태 확인 필요', recovery: '[Y Learner] 운영 상태 정상 복구'};
  const text = {connection: 'Google 예약 실행으로 장애 감시가 처음 작동했습니다. 이 메일은 연결 확인용이며 고객 결제를 만들지 않았습니다.',
    down: '외부 감시에서 두 차례 연속 정상 상태를 확인하지 못했습니다. 사이트, 결제 처리와 정기 작업을 확인해 주세요.',
    recovery: '외부 감시에서 사이트와 운영 상태가 정상으로 돌아온 것을 확인했습니다.'};
  return {to: YL_MONITOR.recipient, replyTo: YL_MONITOR.recipient,
    name: 'Y Learner Operations', subject: subject[event.kind],
    body: text[event.kind] + '\n감지 시각(UTC): ' + event.createdAt +
      '\n현재 공개 상태: ' + JSON.stringify(checks) + '\n사이트: https://y-learner.com' +
      '\n알림 번호: ' + event.sequence};
}
