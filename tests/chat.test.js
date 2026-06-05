/**
 * 聊天管理测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatManager } from '../js/ui/chat.js';
import { clearDomCache } from '../js/utils/helpers.js';

describe('ChatManager', () => {
  let chatManager;

  beforeEach(() => {
    document.body.innerHTML = '<div id="chat-messages"></div>';
    clearDomCache(); // 清除 DOM 缓存
    chatManager = new ChatManager();
  });

  describe('appendMessage', () => {
    it('should append message to container', () => {
      chatManager.appendMessage('Hello', 'local', 'You');
      const container = document.getElementById('chat-messages');
      expect(container.children.length).toBe(1);
      expect(container.children[0].textContent).toBe('You: Hello');
    });

    it('should append message without label', () => {
      chatManager.appendMessage('System message', 'sys');
      const container = document.getElementById('chat-messages');
      expect(container.children.length).toBe(1);
      expect(container.children[0].textContent).toBe('System message');
    });

    it('should set correct class name', () => {
      chatManager.appendMessage('Test', 'remote', 'Peer');
      const container = document.getElementById('chat-messages');
      const msg = container.children[0];
      expect(msg.className).toBe('msg msg-remote');
    });

    it('should return created element', () => {
      const el = chatManager.appendMessage('Test', 'local', 'You');
      expect(el).toBeDefined();
      expect(el.tagName).toBe('DIV');
    });

    it('should handle missing container gracefully', () => {
      // 保存原始 HTML
      const originalHtml = document.body.innerHTML;
      document.body.innerHTML = '';
      clearDomCache(); // 清除缓存
      const el = chatManager.appendMessage('Test', 'local', 'You');
      expect(el).toBeNull();
      // 恢复 HTML
      document.body.innerHTML = originalHtml;
      clearDomCache();
    });
  });

  describe('sendChat', () => {
    it('should add local message and broadcast', () => {
      chatManager.broadcast = vi.fn();
      chatManager.sendChat('Hello');
      
      const container = document.getElementById('chat-messages');
      expect(container.children.length).toBe(1);
      expect(container.children[0].textContent).toBe('You: Hello');
      expect(chatManager.broadcast).toHaveBeenCalledWith({ type: 'chat', text: 'Hello' });
    });

    it('should not send empty message', () => {
      chatManager.broadcast = vi.fn();
      chatManager.sendChat('');
      expect(chatManager.broadcast).not.toHaveBeenCalled();
    });

    it('should not send whitespace only message', () => {
      chatManager.broadcast = vi.fn();
      chatManager.sendChat('   ');
      expect(chatManager.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('clearMessages', () => {
    it('should clear all messages', () => {
      chatManager.appendMessage('Test 1', 'local', 'You');
      chatManager.appendMessage('Test 2', 'remote', 'Peer');
      chatManager.clearMessages();
      
      const container = document.getElementById('chat-messages');
      expect(container.children.length).toBe(0);
    });
  });

  describe('handlePong', () => {
    it('should update ping element to success', () => {
      const el = document.createElement('div');
      el.id = 'ping-123';
      el.textContent = 'Sending Ping...';
      document.body.appendChild(el);
      
      chatManager.handlePong('123');
      expect(el.textContent).toBe('Ping Success!');
    });

    it('should clear timeout', () => {
      const timeout = setTimeout(() => {}, 1000);
      chatManager.pingTimeouts.set('123', timeout);
      
      chatManager.handlePong('123');
      expect(chatManager.pingTimeouts.has('123')).toBe(false);
    });
  });
});
