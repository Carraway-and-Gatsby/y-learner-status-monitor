# Y Learner external operator notifications

This monitor runs outside Lovable. It reads only the fixed five boolean checks
at `https://y-learner.com/api/public/status`; it cannot run application jobs,
access customer records, change billing, or generate AI content.

Two consecutive unhealthy observations cause one email to `contact@cgcorp.io`.
Recovery causes one email. Healthy unchanged state stays quiet. The supplied
workflow requests a run every five minutes; GitHub can delay scheduled runs, so
this is best-effort monitoring without a five-minute delivery guarantee.

The fixed sender uses the existing verified company domain
`y-learner-ops@workshops.cgcorp.io`. A sending-only Resend credential restricted
to that domain belongs only in GitHub Actions Secrets. It is never in source or
monitor state. No application, Stripe, OpenAI, or database credential is needed.

`monitor-state` is a dedicated state branch with minimal availability state.
Pending notifications are committed before sending. The same idempotency key
and fixed payload survive a lost acknowledgement. Unconfirmed delivery older
than 23 hours stops for manual review rather than resending after the provider's
24-hour deduplication window. Local caps are ten emails per UTC day and 300 per
UTC month; failed sends retain the pending event and fail the workflow visibly.

The source is prepared for `Carraway-and-Gatsby/y-learner-status-monitor`.
The owner approved this public monitor-only repository on 2026-10-29. Only
these monitor files, public site URL, business support address and coarse
availability state would be public. The application repository remains private.
Standard GitHub runners in public repositories are free; private repository
runners consume the owner's shared allowance and can be billed above it.

Install `production-monitor.yml` as `.github/workflows/monitor.yml` in the
approved repository. The repository scope is approved. Sender installation, connection-email delivery
and outside-host runs are checked during activation; see Actions for current results. No broad provider account key
or extra service subscription is required.

Tests: `python3 -m unittest discover -s monitor -p 'test_*.py' -v`.
