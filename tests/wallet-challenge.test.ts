import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkWalletChallenge } from '@blink/client';

const now = new Date('2026-10-30T00:00:00.000Z');
const expected = { origin: 'https://api.test', address: '0xABC', action: 'issue' as const, now };
const lines = ['Blink Market wallet identity binding v1', 'This signature only binds your identity. It does not authorize trading, token approvals, or withdrawals.', 'Origin: https://api.test', 'Chain ID: 84532', 'Address: 0xabc', 'Action: issue', 'Challenge ID: id', 'Nonce: nonce', 'Issued At: 2026-10-30T00:00:00.000Z', 'Expires At: 2026-10-30T00:05:00.000Z'];
const response = (parts: string[]) => ({ challengeId: 'id', message: parts.join('\n'), expiresAt: '2026-10-30T00:05:00.000Z' });
test('wallet challenges must match every canonical line and time', () => {
  assert.equal(checkWalletChallenge(response(lines), expected).message, lines.join('\n'));
  for (let i = 0; i < lines.length; i++) {
    const altered = [...lines]; altered[i] = i === 7 ? 'Nonce: ' : altered[i] + 'x';
    assert.throws(() => checkWalletChallenge(response(altered), expected), /WALLET_CHALLENGE_MISMATCH/);
  }
  for (const parts of [[...lines, lines[2]!], lines.slice(1), [...lines.slice(0, 7), 'Nonce: ', ...lines.slice(8)], [...lines.slice(0, 8), 'Issued At: 2026-10-30T00:01:01.000Z', ...lines.slice(9)]])
    assert.throws(() => checkWalletChallenge(response(parts), expected), /WALLET_CHALLENGE_MISMATCH/);
  assert.throws(() => checkWalletChallenge({ ...response(lines), challengeId: 'other' }, expected), /WALLET_CHALLENGE_MISMATCH/);
  assert.throws(() => checkWalletChallenge(response(lines), { ...expected, now: new Date('2026-10-30T00:05:00.000Z') }), /WALLET_CHALLENGE_MISMATCH/);
  const revoke = [...lines.slice(0, 5), 'Action: revoke', 'Key ID: key', ...lines.slice(6)];
  assert.throws(() => checkWalletChallenge(response(revoke), expected), /WALLET_CHALLENGE_MISMATCH/);
  assert.throws(() => checkWalletChallenge(response(lines), { ...expected, action: 'revoke', keyId: 'key' }), /WALLET_CHALLENGE_MISMATCH/);
  assert.equal(checkWalletChallenge(response(revoke), { ...expected, action: 'revoke', keyId: 'KEY' }).challengeId, 'id');
  assert.throws(() => checkWalletChallenge(response(revoke), { ...expected, action: 'revoke', keyId: 'other' }), /WALLET_CHALLENGE_MISMATCH/);
  assert.throws(() => checkWalletChallenge(response(revoke), { ...expected, action: 'revoke' }), /WALLET_CHALLENGE_MISMATCH/);
  assert.throws(() => checkWalletChallenge({ ...response(lines), unexpected: true }, expected), /WALLET_CHALLENGE_MISMATCH/);
});
