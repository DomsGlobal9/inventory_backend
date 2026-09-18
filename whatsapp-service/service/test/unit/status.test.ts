import { describe, expect, it } from 'vitest';
import type { MessageStatus } from '@prisma/client';
import { advanceStatus, isDrop, mapConnectionState, mapEngineMessageStatus } from '../../src/domain/status';

function replay(start: MessageStatus, events: MessageStatus[]): MessageStatus {
  let s = start;
  for (const e of events) s = advanceStatus(s, e) ?? s;
  return s;
}

describe('engine status mapping', () => {
  it('maps Baileys acks', () => {
    expect(mapEngineMessageStatus('PENDING')).toBe('SENT');
    expect(mapEngineMessageStatus('SERVER_ACK')).toBe('SENT');
    expect(mapEngineMessageStatus('DELIVERY_ACK')).toBe('DELIVERED');
    expect(mapEngineMessageStatus('READ')).toBe('READ');
    expect(mapEngineMessageStatus('PLAYED')).toBe('READ');
    expect(mapEngineMessageStatus('ERROR')).toBe('FAILED');
    expect(mapEngineMessageStatus(3)).toBe('DELIVERED');
    expect(mapEngineMessageStatus('something new')).toBeNull();
    expect(mapEngineMessageStatus(undefined)).toBeNull();
  });
});

describe('message status never goes backwards', () => {
  it('in order', () => {
    expect(replay('SENDING', ['SENT', 'DELIVERED', 'READ'])).toBe('READ');
  });
  it('DELIVERED arriving before SENT stays DELIVERED', () => {
    expect(replay('SENDING', ['DELIVERED', 'SENT'])).toBe('DELIVERED');
    expect(advanceStatus('DELIVERED', 'SENT')).toBeNull();
  });
  it('READ before DELIVERED stays READ', () => {
    expect(replay('SENT', ['READ', 'DELIVERED', 'SENT'])).toBe('READ');
  });
  it('duplicates change nothing', () => {
    expect(advanceStatus('DELIVERED', 'DELIVERED')).toBeNull();
    expect(advanceStatus('SENT', 'SENT')).toBeNull();
  });
  it('an error fails a message only before delivery', () => {
    expect(advanceStatus('SENT', 'FAILED')).toBe('FAILED');
    expect(advanceStatus('SENDING', 'FAILED')).toBe('FAILED');
    expect(advanceStatus('DELIVERED', 'FAILED')).toBeNull();
    expect(advanceStatus('READ', 'FAILED')).toBeNull();
  });
  it('a delivered tick after a failure wins: the tick is proof', () => {
    expect(advanceStatus('FAILED', 'DELIVERED')).toBe('DELIVERED');
    expect(advanceStatus('FAILED', 'SENT')).toBeNull();
  });
  it('expired is final', () => {
    expect(advanceStatus('EXPIRED', 'SENT')).toBeNull();
    expect(advanceStatus('EXPIRED', 'DELIVERED')).toBeNull();
    expect(advanceStatus('QUEUED', 'EXPIRED')).toBe('EXPIRED');
    expect(advanceStatus('SENT', 'EXPIRED')).toBeNull();
  });
  it('every permutation of SENT/DELIVERED/READ ends at READ', () => {
    const perms: MessageStatus[][] = [
      ['SENT', 'DELIVERED', 'READ'],
      ['SENT', 'READ', 'DELIVERED'],
      ['DELIVERED', 'SENT', 'READ'],
      ['DELIVERED', 'READ', 'SENT'],
      ['READ', 'SENT', 'DELIVERED'],
      ['READ', 'DELIVERED', 'SENT'],
    ];
    for (const p of perms) expect(replay('SENDING', p)).toBe('READ');
  });
});

describe('account connection mapping', () => {
  it('open is connected', () => {
    expect(mapConnectionState({ state: 'open' }, false)).toBe('CONNECTED');
  });
  it('connecting means showing a QR if never linked, reconnecting if linked', () => {
    expect(mapConnectionState({ state: 'connecting' }, false)).toBe('LINKING');
    expect(mapConnectionState({ state: 'connecting' }, true)).toBe('DISCONNECTED');
  });
  it('closed with 401 or 403 is logged out', () => {
    expect(mapConnectionState({ state: 'close', statusReason: 401 }, true)).toBe('LOGGED_OUT');
    expect(mapConnectionState({ state: 'close', statusReason: 403 }, true)).toBe('LOGGED_OUT');
    expect(mapConnectionState({ state: 'close', statusReason: 428 }, true)).toBe('DISCONNECTED');
    expect(mapConnectionState({ state: 'close', statusReason: 428 }, false)).toBe('NOT_LINKED');
  });
  it('only CONNECTED -> DISCONNECTED/LOGGED_OUT is a drop', () => {
    expect(isDrop('CONNECTED', 'DISCONNECTED')).toBe(true);
    expect(isDrop('CONNECTED', 'LOGGED_OUT')).toBe(true);
    expect(isDrop('DISCONNECTED', 'LOGGED_OUT')).toBe(false);
    expect(isDrop('LINKING', 'NOT_LINKED')).toBe(false);
  });
});
