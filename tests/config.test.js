/**
 * 配置文件测试
 */

import { describe, it, expect } from 'vitest';
import {
  NETWORK,
  AUDIO,
  QOS,
  PEER_ID,
  WORD_LISTS,
  ERROR_MESSAGES,
  QUALITY_LABELS,
  CONN_TYPE_MAP,
} from '../js/config.js';

describe('Configuration', () => {
  describe('NETWORK', () => {
    it('should have valid max peers', () => {
      expect(NETWORK.MAX_PEERS).toBeGreaterThan(0);
      expect(NETWORK.MAX_PEERS).toBeLessThanOrEqual(10);
    });

    it('should have reconnect backoff as array', () => {
      expect(Array.isArray(NETWORK.RECONNECT_BACKOFF)).toBe(true);
      expect(NETWORK.RECONNECT_BACKOFF.length).toBeGreaterThan(0);
    });

    it('should have valid timeouts', () => {
      expect(NETWORK.CALL_STREAM_TIMEOUT).toBeGreaterThan(0);
      expect(NETWORK.MESH_SCAN_INTERVAL).toBeGreaterThan(0);
    });
  });

  describe('AUDIO', () => {
    it('should have valid constraints', () => {
      expect(AUDIO.CONSTRAINTS.audio).toBeDefined();
      expect(AUDIO.CONSTRAINTS.video).toBe(false);
    });

    it('should have valid bitrate values', () => {
      expect(AUDIO.BITRATE.LOW).toBeLessThan(AUDIO.BITRATE.MEDIUM);
      expect(AUDIO.BITRATE.MEDIUM).toBeLessThan(AUDIO.BITRATE.HIGH);
    });
  });

  describe('QOS', () => {
    it('should have valid thresholds', () => {
      expect(QOS.LOSS.BAD).toBeGreaterThan(QOS.LOSS.WARN);
      expect(QOS.JITTER.BAD).toBeGreaterThan(QOS.JITTER.WARN);
      expect(QOS.RTT.BAD).toBeGreaterThan(QOS.RTT.WARN);
    });
  });

  describe('PEER_ID', () => {
    it('should format host id correctly', () => {
      expect(PEER_ID.format.host('test-token')).toBe('isay-test-token-host');
    });

    it('should format guest id correctly', () => {
      expect(PEER_ID.format.guest('test-token', 0)).toBe('isay-test-token-g0');
      expect(PEER_ID.format.guest('test-token', 5)).toBe('isay-test-token-g5');
    });

    it('should parse peer id correctly', () => {
      const hostParsed = PEER_ID.parse('isay-test-token-host');
      expect(hostParsed).toEqual({ token: 'test-token', role: 'host', index: -1 });

      const guestParsed = PEER_ID.parse('isay-test-token-g3');
      expect(guestParsed).toEqual({ token: 'test-token', role: 'guest', index: 3 });
    });

    it('should return null for invalid peer id', () => {
      expect(PEER_ID.parse('invalid')).toBeNull();
    });
  });

  describe('WORD_LISTS', () => {
    it('should have adjectives and nouns', () => {
      expect(Array.isArray(WORD_LISTS.ADJECTIVES)).toBe(true);
      expect(Array.isArray(WORD_LISTS.NOUNS)).toBe(true);
      expect(WORD_LISTS.ADJECTIVES.length).toBeGreaterThan(0);
      expect(WORD_LISTS.NOUNS.length).toBeGreaterThan(0);
    });
  });

  describe('ERROR_MESSAGES', () => {
    it('should have messages for common errors', () => {
      expect(ERROR_MESSAGES.NotAllowedError).toBeDefined();
      expect(ERROR_MESSAGES.NotFoundError).toBeDefined();
      expect(ERROR_MESSAGES.NotReadableError).toBeDefined();
    });

    it('should have required fields', () => {
      for (const [key, value] of Object.entries(ERROR_MESSAGES)) {
        expect(value.title).toBeDefined();
        expect(value.message).toBeDefined();
        expect(value.userMessage).toBeDefined();
      }
    });
  });

  describe('QUALITY_LABELS', () => {
    it('should have labels for all quality levels', () => {
      expect(QUALITY_LABELS[1]).toBeDefined();
      expect(QUALITY_LABELS[5]).toBeDefined();
    });
  });

  describe('CONN_TYPE_MAP', () => {
    it('should have all connection types', () => {
      expect(CONN_TYPE_MAP.checking).toBeDefined();
      expect(CONN_TYPE_MAP.p2p).toBeDefined();
      expect(CONN_TYPE_MAP.relay).toBeDefined();
      expect(CONN_TYPE_MAP.disconnected).toBeDefined();
      expect(CONN_TYPE_MAP.failed).toBeDefined();
    });
  });
});
