import { describe, it, expect } from 'vitest';
import { isChatAllowed } from './allow-list.js';

describe('isChatAllowed', () => {
  describe('open mode (no env var set)', () => {
    it('admits any chat when env is undefined', () => {
      expect(isChatAllowed('13807256', undefined)).toBe(true);
      expect(isChatAllowed('99999999', undefined)).toBe(true);
    });

    it('admits any chat when env is empty string', () => {
      expect(isChatAllowed('13807256', '')).toBe(true);
    });

    it('admits any chat when env is whitespace only', () => {
      expect(isChatAllowed('13807256', '   ')).toBe(true);
    });

    it('admits any chat when env parses to an empty list', () => {
      // Commas with only whitespace between them
      expect(isChatAllowed('13807256', ', , ,')).toBe(true);
    });
  });

  describe('locked mode', () => {
    it('admits a listed chat', () => {
      expect(isChatAllowed('13807256', '13807256')).toBe(true);
    });

    it('admits a listed chat from a multi-entry list', () => {
      expect(isChatAllowed('13807256', '13807256,987654321')).toBe(true);
      expect(isChatAllowed('987654321', '13807256,987654321')).toBe(true);
    });

    it('rejects an unlisted chat', () => {
      expect(isChatAllowed('5303289150', '13807256')).toBe(false);
    });

    it('rejects an unlisted chat from a multi-entry list', () => {
      expect(isChatAllowed('5303289150', '13807256,987654321')).toBe(false);
    });

    it('tolerates whitespace around entries', () => {
      expect(isChatAllowed('13807256', ' 13807256 , 987654321 ')).toBe(true);
      expect(isChatAllowed('987654321', ' 13807256 , 987654321 ')).toBe(true);
      expect(isChatAllowed('5303289150', ' 13807256 , 987654321 ')).toBe(false);
    });

    it('compares chat IDs as strings (does not coerce)', () => {
      // chatIds from Telegram are arbitrary-precision; string compare is
      // what we want, not numeric.
      expect(isChatAllowed('13807256', '13807256')).toBe(true);
      expect(isChatAllowed('0013807256', '13807256')).toBe(false);
    });
  });
});
