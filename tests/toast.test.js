/**
 * Toast 通知测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToastManager } from '../js/ui/toast.js';

describe('ToastManager', () => {
  let toastManager;

  beforeEach(() => {
    toastManager = new ToastManager();
    document.body.innerHTML = '';
    // Mock requestAnimationFrame to execute immediately
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => cb());
  });

  afterEach(() => {
    toastManager.clear();
    vi.restoreAllMocks();
  });

  it('should create container on first use', () => {
    expect(document.getElementById('toast-container')).toBeNull();
    toastManager.show('Test');
    expect(document.getElementById('toast-container')).not.toBeNull();
  });

  it('should create toast element', () => {
    const toast = toastManager.show('Test message');
    expect(toast).toBeDefined();
    // With mocked rAF, show class is added immediately
    expect(toast.className).toBe('toast show');
    expect(toast.textContent).toBe('Test message');
  });

  it('should add show class immediately with mocked rAF', () => {
    const toast = toastManager.show('Test');
    expect(toast.classList.contains('show')).toBe(true);
  });

  it('should remove toast after duration', () => {
    vi.useFakeTimers();
    toastManager.show('Test', 1000);
    const container = document.getElementById('toast-container');
    expect(container.children.length).toBe(1);
    
    vi.advanceTimersByTime(1000);
    expect(container.children.length).toBe(1);
    
    vi.advanceTimersByTime(300);
    expect(container.children.length).toBe(0);
    vi.useRealTimers();
  });

  it('should clear all toasts', () => {
    toastManager.show('Test 1');
    toastManager.show('Test 2');
    toastManager.show('Test 3');
    
    const container = document.getElementById('toast-container');
    expect(container.children.length).toBe(3);
    
    toastManager.clear();
    expect(container.children.length).toBe(0);
  });

  it('should handle multiple toasts', () => {
    toastManager.show('First');
    toastManager.show('Second');
    toastManager.show('Third');
    
    const container = document.getElementById('toast-container');
    expect(container.children.length).toBe(3);
    expect(container.children[0].textContent).toBe('First');
    expect(container.children[1].textContent).toBe('Second');
    expect(container.children[2].textContent).toBe('Third');
  });
});
