/**
 * 屏幕管理测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScreenManager } from '../js/ui/screens.js';

describe('ScreenManager', () => {
  let screenManager;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="screen-landing" class="screen active"></div>
      <div id="screen-waiting" class="screen"></div>
      <div id="screen-call" class="screen"></div>
      <div id="screen-disconnected" class="screen"></div>
    `;
    screenManager = new ScreenManager();
    screenManager.init();
  });

  it('should initialize screens', () => {
    expect(screenManager.screens.landing).toBeDefined();
    expect(screenManager.screens.waiting).toBeDefined();
    expect(screenManager.screens.call).toBeDefined();
    expect(screenManager.screens.disconnected).toBeDefined();
  });

  it('should show correct screen', () => {
    screenManager.show('waiting');
    expect(screenManager.screens.waiting.classList.contains('active')).toBe(true);
    expect(screenManager.screens.landing.classList.contains('active')).toBe(false);
  });

  it('should track current screen', () => {
    expect(screenManager.current()).toBeNull();
    screenManager.show('call');
    expect(screenManager.current()).toBe('call');
  });

  it('should hide other screens when showing one', () => {
    screenManager.show('landing');
    screenManager.show('waiting');
    
    expect(screenManager.screens.landing.classList.contains('active')).toBe(false);
    expect(screenManager.screens.waiting.classList.contains('active')).toBe(true);
    expect(screenManager.screens.call.classList.contains('active')).toBe(false);
  });

  it('should handle invalid screen name gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    screenManager.show('invalid');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
