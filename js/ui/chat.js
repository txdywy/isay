/**
 * iSay 聊天和数据通道管理
 */

import { $ } from '../utils/helpers.js';
import { TIMEOUTS } from '../config.js';
import state from '../state.js';

class ChatManager {
  constructor() {
    this.pingTimeouts = new Map();
  }
  
  /**
   * 初始化数据连接事件
   * @param {import('peerjs').DataConnection} conn
   */
  setupDataConnection(conn) {
    conn.on("open", () => {
      state.addDataConn(conn.peer, conn);
    });
    
    conn.on("data", (data) => {
      this.handleIncomingData(data, conn.peer);
    });
    
    conn.on("close", () => {
      state.removeDataConn(conn.peer);
    });
    
    conn.on("error", () => {
      state.removeDataConn(conn.peer);
    });
  }
  
  /**
   * 处理接收到的数据
   * @param {*} data
   * @param {string} peerId
   */
  handleIncomingData(data, peerId) {
    try {
      const payload = typeof data === 'string' ? JSON.parse(data) : data;
      
      switch (payload.type) {
        case 'chat':
          this.appendMessage(payload.text, "remote", peerId.slice(-4));
          break;
          
        case 'ping':
          this.appendMessage("Received Ping", "ping");
          // 发送 pong 回复
          this.sendToPeer(peerId, { type: "pong", id: payload.id });
          break;
          
        case 'pong':
          this.handlePong(payload.id);
          break;
          
        default:
          // 兼容旧格式
          if (typeof data === "string") {
            this.appendMessage(data, "remote");
          }
      }
    } catch (err) {
      // 非 JSON 数据，直接显示
      if (typeof data === "string") {
        this.appendMessage(data, "remote");
      }
    }
  }
  
  /**
   * 处理 pong 响应
   * @param {string} pingId
   */
  handlePong(pingId) {
    this.appendMessage("Received Pong!", "pong");
    const pingEl = document.getElementById(`ping-${pingId}`);
    if (pingEl) {
      pingEl.textContent = "Ping Success!";
      pingEl.classList.remove("msg-sys");
      pingEl.classList.add("msg-pong");
    }
    // 清除超时
    if (this.pingTimeouts.has(pingId)) {
      clearTimeout(this.pingTimeouts.get(pingId));
      this.pingTimeouts.delete(pingId);
    }
  }
  
  /**
   * 发送消息给指定 peer
   * @param {string} peerId
   * @param {Object} payload
   */
  sendToPeer(peerId, payload) {
    const conn = state.dataConns.get(peerId);
    if (conn && conn.open) {
      conn.send(JSON.stringify(payload));
    }
  }
  
  /**
   * 广播消息给所有 peers
   * @param {Object} payload
   */
  broadcast(payload) {
    const dataStr = JSON.stringify(payload);
    for (const [id, conn] of state.dataConns) {
      if (conn.open) {
        try {
          conn.send(dataStr);
        } catch (err) {
          console.warn('[Chat] Failed to send to', id, err);
        }
      }
    }
  }
  
  /**
   * 添加聊天消息到 UI
   * @param {string} text
   * @param {string} [type='sys'] - sys, local, remote, ping, pong
   * @param {string} [label='']
   * @returns {HTMLElement}
   */
  appendMessage(text, type = "sys", label = "") {
    const container = $("#chat-messages");
    if (!container) return null;
    
    const el = document.createElement("div");
    el.className = `msg msg-${type}`;
    el.textContent = label ? `${label}: ${text}` : text;
    container.appendChild(el);
    
    // 自动滚动到底部
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
    
    return el;
  }
  
  /**
   * 发送聊天消息
   * @param {string} text
   */
  sendChat(text) {
    if (!text.trim()) return;
    this.appendMessage(text, "local", "You");
    this.broadcast({ type: "chat", text });
  }
  
  /**
   * 发送 Ping
   */
  sendPing() {
    if (state.dataConns.size === 0) {
      this.appendMessage("No peers connected for Ping", "sys");
      return;
    }
    
    const pingId = Date.now().toString();
    const el = this.appendMessage("Sending Ping...", "ping");
    if (el) el.id = `ping-${pingId}`;
    
    this.broadcast({ type: "ping", id: pingId });
    
    // 设置超时
    const timeout = setTimeout(() => {
      if (el && el.textContent === "Sending Ping...") {
        el.textContent = "Ping Timeout";
        el.classList.remove("msg-ping");
        el.classList.add("msg-sys");
        el.style.color = "var(--danger)";
      }
      this.pingTimeouts.delete(pingId);
    }, TIMEOUTS.PING_TIMEOUT);
    
    this.pingTimeouts.set(pingId, timeout);
  }
  
  /**
   * 清除所有聊天消息
   */
  clearMessages() {
    const container = $("#chat-messages");
    if (container) container.innerHTML = "";
  }
  
  /**
   * 清除所有 ping 超时
   */
  clearPingTimeouts() {
    for (const timeout of this.pingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pingTimeouts.clear();
  }
}

// 单例导出
const chatManager = new ChatManager();

export function setupDataConnection(conn) {
  chatManager.setupDataConnection(conn);
}

export function broadcastData(payload) {
  chatManager.broadcast(payload);
}

export function appendChatMessage(text, type, label) {
  return chatManager.appendMessage(text, type, label);
}

export default chatManager;
export { ChatManager };
