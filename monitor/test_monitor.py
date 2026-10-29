import copy
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('monitor', pathlib.Path(__file__).with_name('run.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = 1793257200
KEY = 're_synthetic_not_a_real_credential'


class Store:
    def __init__(self, state=None, fail_at=None):
        self.value = copy.deepcopy(state or m.initial_state())
        self.writes = []
        self.fail_at = fail_at

    def load(self):
        return copy.deepcopy(self.value)

    def save(self, state):
        self.writes.append(copy.deepcopy(state))
        if len(self.writes) == self.fail_at:
            raise m.MonitorError('state_write_failed')
        self.value = copy.deepcopy(state)


class Transport:
    def __init__(self, healthy=True, mail_status=200):
        self.healthy = healthy
        self.mail_status = mail_status
        self.sent = []

    def __call__(self, url, **options):
        if url == m.ORIGIN + '/api/public/status':
            return (200 if self.healthy else 503), {k: self.healthy for k in m.CHECKS}
        if url == 'https://api.resend.com/emails':
            self.sent.append(copy.deepcopy(options))
            return self.mail_status, {'id': 'synthetic-email-id'}
        raise AssertionError('Unapproved network destination')


class MonitorTests(unittest.TestCase):
    def test_api_transport_identifies_application_without_following_redirects(self):
        with patch.object(m.urllib.request, 'build_opener') as build:
            response = build.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b'{}'
            self.assertEqual(m.request('https://api.resend.com/usage'), (200, {}))
            req = build.return_value.open.call_args.args[0]
            self.assertEqual(req.get_header('User-agent'), m.USER_AGENT)
            self.assertIs(build.call_args.args[0], m.NoRedirect)

    def test_healthy_runs_are_quiet(self):
        store, transport = Store(), Transport()
        self.assertEqual(m.run(store, KEY, NOW, fetch=transport), 'unchanged')
        self.assertEqual(store.value['status'], 'up')
        self.assertEqual(m.run(store, KEY, NOW + 300, fetch=transport), 'unchanged')
        self.assertEqual(transport.sent, [])

    def test_two_failures_alert_once_then_recovery_once(self):
        store, transport = Store(), Transport(False)
        self.assertEqual(m.run(store, KEY, NOW, fetch=transport), 'unchanged')
        self.assertEqual(m.run(store, KEY, NOW + 300, fetch=transport), 'provider_accepted')
        self.assertEqual(len(transport.sent), 1)
        m.run(store, KEY, NOW + 600, fetch=transport)
        self.assertEqual(len(transport.sent), 1)
        transport.healthy = True
        self.assertEqual(m.run(store, KEY, NOW + 900, fetch=transport), 'provider_accepted')
        m.run(store, KEY, NOW + 1200, fetch=transport)
        self.assertEqual(len(transport.sent), 2)
        self.assertIn('정상 복구', transport.sent[-1]['body']['subject'])

    def test_single_transient_failure_does_not_notify(self):
        store, transport = Store(), Transport(False)
        m.run(store, KEY, NOW, fetch=transport)
        transport.healthy = True
        m.run(store, KEY, NOW + 300, fetch=transport)
        self.assertEqual(transport.sent, [])

    def test_pending_event_persisted_before_send(self):
        store, transport = Store(fail_at=1), Transport()
        with self.assertRaises(m.MonitorError):
            m.run(store, KEY, NOW, test=True, fetch=transport)
        self.assertEqual(transport.sent, [])

    def test_lost_ack_retries_identical_payload_and_key(self):
        store, transport = Store(fail_at=2), Transport()
        with self.assertRaises(m.MonitorError):
            m.run(store, KEY, NOW, test=True, fetch=transport)
        self.assertIsNotNone(store.value['pending'])
        store.fail_at = None
        m.run(store, KEY, NOW + 300, fetch=transport)
        self.assertEqual(transport.sent[0], transport.sent[1])
        self.assertIsNone(store.value['pending'])

    def test_failed_provider_keeps_pending_without_false_delivery(self):
        store, transport = Store(), Transport(mail_status=429)
        with self.assertRaisesRegex(m.MonitorError, 'email_delivery_unconfirmed'):
            m.run(store, KEY, NOW, test=True, fetch=transport)
        self.assertIsNotNone(store.value['pending'])
        self.assertEqual(store.value['daily_sent'], 0)

    def test_no_automatic_resend_beyond_idempotency_retention(self):
        pending = m.transition(m.initial_state(), 'up', NOW, test=True)
        store, transport = Store(pending), Transport()
        with self.assertRaisesRegex(m.MonitorError, 'manual_review'):
            m.run(store, KEY, NOW + 23 * 3600, fetch=transport)
        self.assertEqual(transport.sent, [])

    def test_fixed_recipient_sender_and_no_keys_in_message(self):
        transport = Transport()
        m.run(Store(), KEY, NOW, test=True, fetch=transport)
        payload = transport.sent[0]['body']
        self.assertEqual(payload['to'], ['contact@cgcorp.io'])
        self.assertEqual(payload['from'], m.SENDER)
        self.assertNotIn(KEY, str(payload))
        self.assertNotIn('Authorization', str(payload))

    def test_sender_never_accepts_recipient_or_body_from_state(self):
        state = m.initial_state()
        state['to'] = 'attacker@example.test'
        with self.assertRaisesRegex(m.MonitorError, 'invalid_monitor_state'):
            m.transition(state, 'up', NOW)

    def test_daily_and_monthly_caps_do_not_send(self):
        for key, cap in [('daily_sent', m.MAX_DAILY_EMAILS), ('monthly_sent', m.MAX_MONTHLY_EMAILS)]:
            state = m.transition(m.initial_state(), 'up', NOW)
            state[key] = cap
            transport = Transport()
            with self.assertRaisesRegex(m.MonitorError, 'quota'):
                m.run(Store(state), KEY, NOW, test=True, fetch=transport)
            self.assertEqual(transport.sent, [])

    def test_invalid_credentials_cause_no_reads_or_sends(self):
        transport = Transport()
        with self.assertRaisesRegex(m.MonitorError, 'configuration'):
            m.run(Store(), '', NOW, fetch=transport)
        self.assertEqual(transport.sent, [])

    def test_invalid_health_bodies_fail_closed(self):
        good = {k: True for k in m.CHECKS}
        cases = [(200, {}), (200, 'private html'), (200, {'status': 'ok', 'checks': {}}),
                 (503, good), (302, good), (200, {**good, 'jobs': 1})]
        for response in cases:
            self.assertEqual(m.observe(lambda *args, **kwargs: response), 'down')

    def test_network_failure_is_down(self):
        def unavailable(*args, **kwargs):
            raise m.MonitorError('transport_unavailable')
        self.assertEqual(m.observe(unavailable), 'down')

    def test_invalid_future_pending_never_sends(self):
        state = m.transition(m.initial_state(), 'up', NOW + 300, test=True)
        transport = Transport()
        with self.assertRaisesRegex(m.MonitorError, 'manual_review'):
            m.run(Store(state), KEY, NOW, fetch=transport)
        self.assertEqual(transport.sent, [])


if __name__ == '__main__':
    unittest.main()
