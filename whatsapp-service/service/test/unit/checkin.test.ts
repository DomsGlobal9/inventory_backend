import { describe, expect, it } from 'vitest';
import { checkInCode } from '../../src/domain/checkin';

describe('checkInCode', () => {
  it('finds the door code in the message the QR writes', () => {
    expect(checkInCode("Hi! I'm at Lakshmi Silks, Main Store. Check-in code: IN-4K2Q9M")).toBe('4K2Q9M');
  });
  it('reads it however the customer edited the message around it', () => {
    expect(checkInCode('in-4k2q9m')).toBe('4K2Q9M');
    expect(checkInCode('hello (IN-4K2Q9M) coming in')).toBe('4K2Q9M');
    expect(checkInCode('IN-4K2Q9M.')).toBe('4K2Q9M');
  });
  it('ignores anything that is not exactly a code', () => {
    expect(checkInCode('Hi, is the shop open?')).toBeNull();
    expect(checkInCode('IN-4K2Q9')).toBeNull();          // five
    expect(checkInCode('IN-4K2Q9MX')).toBeNull();        // seven
    expect(checkInCode('BIN-4K2Q9M')).toBeNull();        // part of a longer word
    expect(checkInCode('')).toBeNull();
    expect(checkInCode(undefined as unknown as string)).toBeNull();
  });
});
