/**
 * 工具函数测试
 */

import { describe, it, expect, vi } from 'vitest';
import { sanitizeToken, generateToken, formatDuration, debounce, throttle } from '../js/utils/helpers.js';
import { WORD_LISTS } from '../js/config.js';

describe('Token Functions', () => {
  describe('generateToken', () => {
    it('should generate token with correct format', () => {
      const token = generateToken(WORD_LISTS.ADJECTIVES, WORD_LISTS.NOUNS);
      expect(token).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
    });

    it('should generate unique tokens', () => {
      const tokens = new Set(
        Array.from({ length: 100 }, () => generateToken(WORD_LISTS.ADJECTIVES, WORD_LISTS.NOUNS))
      );
      expect(tokens.size).toBeGreaterThan(90);
    });
  });

  describe('sanitizeToken', () => {
    it('should sanitize valid token', () => {
      expect(sanitizeToken('brave-wolf-42')).toBe('brave-wolf-42');
    });

    it('should convert to lowercase', () => {
      expect(sanitizeToken('Brave-Wolf-42')).toBe('brave-wolf-42');
    });

    it('should remove invalid characters', () => {
      expect(sanitizeToken('brave wolf 42!')).toBe('bravewolf42');
    });

    it('should trim whitespace', () => {
      expect(sanitizeToken('  brave-wolf-42  ')).toBe('brave-wolf-42');
    });

    it('should return null for empty string', () => {
      expect(sanitizeToken('')).toBeNull();
    });

    it('should return null for too short token', () => {
      expect(sanitizeToken('ab')).toBeNull();
    });

    it('should return null for too long token', () => {
      expect(sanitizeToken('a'.repeat(33))).toBeNull();
    });

    it('should return null for non-string input', () => {
      expect(sanitizeToken(null)).toBeNull();
      expect(sanitizeToken(undefined)).toBeNull();
      expect(sanitizeToken(123)).toBeNull();
    });
  });
});

describe('Utility Functions', () => {
  describe('formatDuration', () => {
    it('should format seconds correctly', () => {
      expect(formatDuration(0)).toBe('00:00');
      expect(formatDuration(30)).toBe('00:30');
      expect(formatDuration(60)).toBe('01:00');
      expect(formatDuration(90)).toBe('01:30');
      expect(formatDuration(3661)).toBe('61:01');
    });

    it('should pad with zeros', () => {
      expect(formatDuration(5)).toBe('00:05');
      expect(formatDuration(65)).toBe('01:05');
    });
  });

  describe('debounce', () => {
    it('should debounce function calls', async () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      const debouncedFn = debounce(fn, 100);

      debouncedFn();
      debouncedFn();
      debouncedFn();

      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe('throttle', () => {
    it('should throttle function calls', () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      const throttledFn = throttle(fn, 100);

      throttledFn();
      throttledFn();
      throttledFn();

      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(100);
      throttledFn();
      expect(fn).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });
});
