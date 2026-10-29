"""Outside-host availability monitor. Standard library only; no customer data."""
import base64
import copy
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ORIGIN = 'https://y-learner.com'
REPOSITORY = 'Carraway-and-Gatsby/y-learner-status-monitor'
RECIPIENT = 'contact@cgcorp.io'
SENDER = 'Y Learner Operations <y-learner-ops@workshops.cgcorp.io>'
CHECKS = ('site', 'schema', 'payments', 'jobs', 'monitor')
BRANCH = 'monitor-state'
MAX_DAILY_EMAILS = 10
MAX_MONTHLY_EMAILS = 300
USER_AGENT = 'y-learner-status-monitor/1.0 (+https://y-learner.com)'


class MonitorError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, method='GET', body=None, headers=None):
    """Never log URLs, headers, credentials, provider errors or response content."""
    data = None if body is None else json.dumps(body, separators=(',', ':')).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={'Content-Type': 'application/json', 'User-Agent': USER_AGENT,
                                          **(headers or {})})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=10) as response:
            raw = response.read(65537)
            if len(raw) > 65536:
                raise MonitorError('response_too_large')
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        # Do not decode or expose upstream error bodies (which may contain input).
        return error.code, {}
    except (OSError, ValueError) as error:
        raise MonitorError('transport_unavailable') from None


def observe(fetch=request):
    try:
        status, body = fetch(ORIGIN + '/api/public/status')
        healthy = (status == 200 and isinstance(body, dict) and set(body) == set(CHECKS)
                   and all(body[name] is True for name in CHECKS))
        return 'up' if healthy else 'down'
    except MonitorError:
        return 'down'


def initial_state():
    return {'version': 1, 'status': 'unknown', 'failures': 0, 'sequence': 0,
            'pending': None, 'day': '', 'month': '', 'daily_sent': 0, 'monthly_sent': 0}


def validate_state(value):
    expected = initial_state()
    if not isinstance(value, dict) or set(value) != set(expected) or value['version'] != 1:
        raise MonitorError('invalid_monitor_state')
    if value['status'] not in ('unknown', 'up', 'down'):
        raise MonitorError('invalid_monitor_state')
    for key in ('failures', 'sequence', 'daily_sent', 'monthly_sent'):
        if type(value[key]) is not int or not 0 <= value[key] <= 1_000_000_000:
            raise MonitorError('invalid_monitor_state')
    if not re.fullmatch(r'(|\d{4}-\d{2}-\d{2})', value['day']) or not re.fullmatch(r'(|\d{4}-\d{2})', value['month']):
        raise MonitorError('invalid_monitor_state')
    pending = value['pending']
    if pending is not None:
        if (not isinstance(pending, dict) or set(pending) != {'kind', 'sequence', 'created'}
                or pending['kind'] not in ('down', 'recovery', 'test')
                or type(pending['sequence']) is not int or pending['sequence'] != value['sequence']
                or type(pending['created']) is not int or pending['created'] < 0):
            raise MonitorError('invalid_monitor_state')
    return value


def transition(state, observation, now, test=False):
    state = copy.deepcopy(validate_state(state))
    day = dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime('%Y-%m-%d')
    if state['day'] != day:
        state.update(day=day, daily_sent=0)
    if state['month'] != day[:7]:
        state.update(month=day[:7], monthly_sent=0)
    # Persist an immutable pending event BEFORE sending. A lost provider response
    # retries exactly the same key/body within its documented 24h window.
    if state['pending'] is not None:
        return state
    kind = None
    if test:
        kind = 'test'
    elif observation == 'down':
        state['failures'] = min(2, state['failures'] + 1)
        if state['failures'] >= 2 and state['status'] != 'down':
            kind = 'down'
            state['status'] = 'down'
    elif observation == 'up':
        state['failures'] = 0
        if state['status'] == 'down':
            kind = 'recovery'
        state['status'] = 'up'
    else:
        raise MonitorError('invalid_observation')
    if kind:
        state['sequence'] += 1
        state['pending'] = {'kind': kind, 'sequence': state['sequence'], 'created': int(now)}
    return state


def email_payload(event):
    stamp = dt.datetime.fromtimestamp(event['created'], dt.timezone.utc).isoformat()
    subjects = {'down': '[Y Learner] 운영 상태 확인 필요',
                'recovery': '[Y Learner] 운영 상태 정상 복구',
                'test': '[Y Learner] 장애 알림 연결 확인'}
    texts = {'down': '외부 감시에서 두 차례 연속 정상 상태를 확인하지 못했습니다. 사이트 접속, 결제 이벤트, 정기 작업 및 감시 기록을 확인해 주세요.',
             'recovery': '외부 감시에서 사이트와 운영 상태가 정상으로 돌아온 것을 확인했습니다.',
             'test': 'contact@cgcorp.io 운영자 알림 연결 확인용 메일입니다. 고객 결제나 실제 장애를 만들지 않았습니다.'}
    return {'from': SENDER, 'to': [RECIPIENT], 'reply_to': RECIPIENT,
            'subject': subjects[event['kind']],
            'text': texts[event['kind']] + '\n확인 시각(UTC): ' + stamp + '\n사이트: ' + ORIGIN}


class GitHubStore:
    def __init__(self, token, sha, fetch=request):
        if not token or not re.fullmatch('[0-9a-f]{40}', sha):
            raise MonitorError('github_configuration_missing')
        self.headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'y-learner-monitor'}
        self.base = 'https://api.github.com/repos/' + REPOSITORY
        self.sha = sha
        self.fetch = fetch
        self.file_sha = None

    def load(self):
        status, body = self.fetch(self.base + '/contents/monitor-state.json?ref=' + BRANCH, headers=self.headers)
        if status == 404:
            # Only create a missing branch; a missing file on an existing branch
            # is initialized explicitly. Never reset or force-push any branch.
            status, _ = self.fetch(self.base + '/git/refs', method='POST',
                                   body={'ref': 'refs/heads/' + BRANCH, 'sha': self.sha}, headers=self.headers)
            if status not in (201, 422):
                raise MonitorError('state_branch_unavailable')
            status, body = self.fetch(self.base + '/contents/monitor-state.json?ref=' + BRANCH, headers=self.headers)
            if status == 404:
                return initial_state()
        if status != 200:
            raise MonitorError('state_read_failed')
        try:
            self.file_sha = body['sha']
            return validate_state(json.loads(base64.b64decode(body['content'], validate=False)))
        except (KeyError, ValueError, TypeError):
            raise MonitorError('invalid_monitor_state') from None

    def save(self, value):
        validate_state(value)
        payload = {'message': 'Record availability monitor state', 'branch': BRANCH,
                   'content': base64.b64encode(json.dumps(value, sort_keys=True).encode()).decode()}
        if self.file_sha:
            payload['sha'] = self.file_sha
        status, body = self.fetch(self.base + '/contents/monitor-state.json', method='PUT', body=payload, headers=self.headers)
        if status not in (200, 201):
            raise MonitorError('state_write_failed')
        self.file_sha = body['content']['sha']


def run(store, key, now=None, test=False, fetch=request):
    now = int(time.time()) if now is None else int(now)
    if not key or not re.fullmatch(r're_[A-Za-z0-9_-]{10,}', key):
        raise MonitorError('email_configuration_missing')
    old = store.load()
    state = transition(old, observe(fetch), now, test)
    if state != old:
        store.save(state)
    event = state['pending']
    if event is None:
        return 'unchanged'
    age = now - event['created']
    if age < 0 or age >= 23 * 3600:
        # Do not resend uncertain delivery beyond provider idempotency retention.
        raise MonitorError('delivery_requires_manual_review')
    if state['daily_sent'] >= MAX_DAILY_EMAILS or state['monthly_sent'] >= MAX_MONTHLY_EMAILS:
        raise MonitorError('email_local_quota_reached')
    idem = f"y-learner-ops/{event['kind']}/{event['sequence']}/{event['created']}"
    status, body = fetch('https://api.resend.com/emails', method='POST', body=email_payload(event),
                         headers={'Authorization': 'Bearer ' + key, 'Idempotency-Key': idem})
    if status not in (200, 201) or not isinstance(body, dict) or not isinstance(body.get('id'), str) or not body['id']:
        raise MonitorError('email_delivery_unconfirmed')
    state.update(pending=None, daily_sent=state['daily_sent'] + 1, monthly_sent=state['monthly_sent'] + 1)
    store.save(state)
    return 'provider_accepted'


def main():
    # Restrict production delivery to the reviewed repository/default workflow.
    if os.getenv('GITHUB_REPOSITORY') != REPOSITORY or os.getenv('GITHUB_REF') != 'refs/heads/main':
        raise MonitorError('unapproved_repository_or_ref')
    store = GitHubStore(os.getenv('GITHUB_TOKEN'), os.getenv('GITHUB_SHA', ''))
    result = run(store, os.getenv('RESEND_API_KEY'), test=os.getenv('SEND_CONNECTION_TEST') == 'true')
    print(json.dumps({'monitor': result}))


if __name__ == '__main__':
    try:
        main()
    except MonitorError as error:
        print(json.dumps({'monitor': 'failed', 'code': str(error)}))
        sys.exit(1)
    except Exception:
        print(json.dumps({'monitor': 'failed', 'code': 'unexpected_error'}))
        sys.exit(1)
