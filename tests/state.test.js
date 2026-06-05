/**
 * 状态管理测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StateManager } from '../js/state.js';

describe('StateManager', () => {
  let state;

  beforeEach(() => {
    state = new StateManager();
  });

  describe('Event System', () => {
    it('should register and emit events', () => {
      const handler = vi.fn();
      state.on('test', handler);
      state.emit('test', { data: 'test' });
      expect(handler).toHaveBeenCalledWith({ data: 'test' });
    });

    it('should support multiple listeners', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      state.on('test', handler1);
      state.on('test', handler2);
      state.emit('test');
      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should unsubscribe correctly', () => {
      const handler = vi.fn();
      const unsubscribe = state.on('test', handler);
      unsubscribe();
      state.emit('test');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle errors in event handlers gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      state.on('test', () => { throw new Error('Test error'); });
      expect(() => state.emit('test')).not.toThrow();
      consoleSpy.mockRestore();
    });
  });

  describe('Timer Management', () => {
    it('should set and clear timers', () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      state.setTimer('test', fn, 100);
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should replace existing timer with same id', () => {
      vi.useFakeTimers();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      state.setTimer('test', fn1, 100);
      state.setTimer('test', fn2, 100);
      vi.advanceTimersByTime(100);
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should clear all timers', () => {
      vi.useFakeTimers();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      state.setTimer('test1', fn1, 100);
      state.setTimer('test2', fn2, 100);
      state.clearAllTimers();
      vi.advanceTimersByTime(100);
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('Peer Management', () => {
    it('should add and retrieve peers', () => {
      const call = { close: vi.fn() };
      const remoteAudio = { pause: vi.fn() };
      state.addPeer('peer1', call, remoteAudio, null);
      expect(state.hasPeer('peer1')).toBe(true);
      expect(state.peerCount).toBe(1);
    });

    it('should remove peers', () => {
      state.addPeer('peer1', {}, null, null);
      const removed = state.removePeer('peer1');
      expect(removed).toBeDefined();
      expect(state.hasPeer('peer1')).toBe(false);
      expect(state.peerCount).toBe(0);
    });

    it('should emit events on peer changes', () => {
      const addHandler = vi.fn();
      const removeHandler = vi.fn();
      state.on('peer:add', addHandler);
      state.on('peer:remove', removeHandler);

      state.addPeer('peer1', {}, null, null);
      expect(addHandler).toHaveBeenCalledWith({ peerId: 'peer1', peerCount: 1 });

      state.removePeer('peer1');
      expect(removeHandler).toHaveBeenCalledWith({ peerId: 'peer1', peerCount: 0 });
    });
  });

  describe('State Reset', () => {
    it('should reset state correctly', () => {
      state.currentToken = 'test-token';
      state.currentRole = 'host';
      state.isMuted = true;
      state.reset();
      expect(state.currentToken).toBeNull();
      expect(state.currentRole).toBeNull();
      expect(state.isMuted).toBe(false);
    });
  });
});
