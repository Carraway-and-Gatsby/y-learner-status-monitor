# Y Learner external operator notifications

The primary monitor is a private standalone Google Apps Script running under the
existing company Google Workspace account. It checks the fixed public endpoint
`https://y-learner.com/api/public/status` every five minutes and sends operator
email to `contact@cgcorp.io`. No application, Stripe, OpenAI or database key is
used. The application repository stays private; this repository contains only
monitor code, the public URL, business contact address and coarse health checks.

## Active Google monitor

Install `google-apps-script/Code.gs` and `google-apps-script/appsscript.json`
in a private standalone Apps Script project. Keep the default Google Cloud
project; do not deploy as a web app or enable paid advanced services. The only
OAuth scopes are public external requests, sending mail, and managing script
triggers. MailApp cannot read the inbox. The owner must approve these scopes.

Run `setupMonitor` once as the owner. It installs or reuses exactly one
five-minute clock without sending a manual test or resetting state. The first
real configured clock callback sends one connection email. `ylMonitorClock`
rejects manual calls, incorrect trigger IDs and non-FULL authorization before
counting a run. `readMonitorStatus` is read-only and sends no email.

Two consecutive unhealthy observations cause one outage email; recovery causes
one recovery email. Unchanged healthy state stays quiet after the initial
connection email. Site, schema, payment processing, worker heartbeats and the
application monitor are checked as five coarse booleans. This is operational
readiness monitoring, not a notification for every customer card decline.
Redirects, invalid TLS, malformed responses and non-200 responses fail closed.

The state and last twelve minimal audit events live in private Script Properties.
Email attempts are capped at ten per UTC day and 300 per UTC month, subject to
the owner's remaining MailApp quota. An attempt is persisted before sending.
If acknowledgement is uncertain, the pending notification stops for operator
review rather than sending a possible duplicate. Inspect `readMonitorStatus`
and Google Executions on execution failure; do not clear attempted pending
state unless delivery is reconciled. Native Google trigger failure notices go
to the trigger owner, so that account must also remain monitored.

On 2026-10-29, native Google **Time-Driven** executions at 23:00:34, 23:05:34 and
23:10:34 KST completed. The first automatic callback received MailApp acceptance
for one connection email; later callbacks sent none. All five checks were true,
with no pending notification. Recipient inbox delivery is not independently
verified: Google requests identity verification for the recipient's mailbox.
Editor executions are excluded from the automatic execution evidence.

This uses Apps Script included with the existing Workspace account; no new paid
subscription or billing-linked Cloud project was configured. At five-minute
intervals it requests 288 HTTP checks per day. Google quotas may change; quota
exhaustion stops execution. Scheduling and delivery are best effort, without an
exact five-minute SLA. See [Google quotas](https://developers.google.com/apps-script/guides/services/quotas),
[clock triggers](https://developers.google.com/apps-script/reference/script/clock-trigger-builder),
and [MailApp permissions](https://developers.google.com/apps-script/reference/mail/mail-app).

Run the offline tests with `node --test google-apps-script/test-monitor.mjs`.
Fifteen cases cover clock-only counting, repeat quietness, failure/recovery,
quota caps, ambiguous sends, stale pending coalescing and strict response checks.

## Legacy GitHub monitor

GitHub's native schedule never produced an event during the bounded diagnostic
window; manual workflow runs do not prove scheduling. The former workflow is
**disabled**, and its `schedule` configuration has been removed. Keep it disabled
to avoid duplicate notices. No GitHub support inquiry was sent.

The retained Python monitor and manual-only workflow are recovery material.
Its sending-only, domain-restricted Resend credential remains encrypted in
GitHub Actions Secrets and is not copied into Google. The legacy minimal state
branch and history are preserved. Re-enabling this fallback requires an
intentional operator decision; it is not the active scheduler.

Legacy tests: `python3 -m unittest discover -s monitor -p 'test_*.py' -v`.
