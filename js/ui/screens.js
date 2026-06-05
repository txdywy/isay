/**
 * iSay 屏幕管理
 * 管理应用的 4 个屏幕状态切换
 */

import { $, $$, announce } from '../utils/helpers.js';

class ScreenManager {
  constructor() {
    this.screens = {
      landing: null,
      waiting: null,
      call: null,
      disconnected: null,
    };
    this.currentScreen = null;
  }
  
  /**
   * 初始化屏幕引用
   */
  init() {
    this.screens.landing = $("#screen-landing");
    this.screens.waiting = $("#screen-waiting");
    this.screens.call = $("#screen-call");
    this.screens.disconnected = $("#screen-disconnected");
  }
  
  /**
   * 切换到指定屏幕
   * @param {string} name - 屏幕名称: landing, waiting, call, disconnected
   */
  show(name) {
    if (!this.screens[name]) {
      console.error(`[Screen] Unknown screen: ${name}`);
      return;
    }
    
    Object.values(this.screens).forEach((s) => {
      if (s) s.classList.remove("active");
    });
    
    this.screens[name].classList.add("active");
    this.currentScreen = name;
  }
  
  /**
   * 获取当前屏幕名称
   * @returns {string|null}
   */
  current() {
    return this.currentScreen;
  }
}

// 单例导出
const screenManager = new ScreenManager();

/**
 * 设置连接阶段指示器
 * @param {string} name - signaling, ice, connected
 */
export function setPhase(name) {
  const order = ["signaling", "ice", "connected"];
  const idx = order.indexOf(name);
  const label = {
    signaling: "Establishing signaling...",
    ice: "Negotiating connection...",
    connected: "Connected",
  };
  
  $$(".phase-step").forEach((el) => {
    const p = el.dataset.phase;
    const pi = order.indexOf(p);
    el.classList.toggle("done", pi < idx);
    el.classList.toggle("active", pi === idx);
  });
  
  $$(".phase-line").forEach((line, i) => {
    line.classList.toggle("done", i < idx);
    line.classList.toggle("active", i === idx);
  });
  
  const lbl = $("#phase-label");
  if (lbl) lbl.textContent = label[name] || "";
  announce(label[name] || "");
}

/**
 * 更新通话状态文本
 * @param {string} text
 */
export function updateCallStatusText(text) {
  const el = $("#call-status-text");
  if (el) el.textContent = text;
}

/**
 * 更新通话时长显示
 * @param {string} text
 */
export function updateDurationDisplay(text) {
  const el = $("#call-duration");
  if (el) el.textContent = text;
}

/**
 * 更新连接类型显示
 * @param {string} type - checking, p2p, relay, disconnected, failed
 */
export function setConnType(type) {
  const badge = $("#conn-type-badge");
  const icon = $("#conn-icon");
  const text = $("#conn-type-text");
  
  if (badge) badge.className = `conn-badge ${  type}`;
  
  const map = {
    checking: { icon: "...", text: "Connecting" },
    p2p: { icon: "P", text: "Direct P2P" },
    relay: { icon: "R", text: "Relay (TURN)" },
    disconnected: { icon: "!", text: "Reconnecting" },
    failed: { icon: "X", text: "Failed" },
  };
  
  const m = map[type] || map.checking;
  if (icon) icon.textContent = m.icon;
  if (text) text.textContent = m.text;
}

/**
 * 更新质量指示器
 * @param {number} level - 1-5
 * @param {string} label
 */
export function setQuality(level, label) {
  const el = $("#quality-segments");
  const labelEl = $("#quality-label");
  if (el) el.setAttribute("data-quality", level);
  if (labelEl) labelEl.textContent = label;
}

/**
 * 更新指标显示
 * @param {number} latency
 * @param {number} jitter
 * @param {number} loss
 */
export function updateMetrics(latency, jitter, loss) {
  const lv = $("#metric-latency");
  const jv = $("#metric-jitter");
  const lo = $("#metric-loss");
  
  if (lv) {
    lv.textContent = latency >= 0 ? Math.round(latency) : "--";
    lv.style.color = latency < 0 ? "" : latency < 100 ? "var(--success)" : latency < 300 ? "var(--warning)" : "var(--danger)";
  }
  
  if (jv) {
    jv.textContent = jitter >= 0 ? Math.round(jitter) : "--";
    jv.style.color = jitter < 0 ? "" : jitter < 30 ? "var(--success)" : jitter < 80 ? "var(--warning)" : "var(--danger)";
  }
  
  if (lo) {
    lo.textContent = loss >= 0 ? `${loss.toFixed(1)  }%` : "--";
    lo.style.color = loss < 0 ? "" : loss < 2 ? "var(--success)" : loss < 5 ? "var(--warning)" : "var(--danger)";
  }
}

/**
 * 更新人数显示
 * @param {number} count
 */
export function updatePeerCount(count) {
  const el = $("#peer-count");
  if (el) el.textContent = count > 1 ? `${count} people` : "Waiting...";
  
  const statusEl = $("#call-status-text");
  if (statusEl && count > 1) {
    statusEl.textContent = count > 2 ? `Group Call (${count})` : "Connected";
  }
}

/**
 * 更新静音按钮状态
 * @param {boolean} isMuted
 */
export function updateMuteButton(isMuted) {
  const btn = $("#btn-mute");
  const iconOn = $("#icon-mic-on");
  const iconOff = $("#icon-mic-off");
  const label = $("#mute-label");
  
  if (btn) {
    btn.classList.toggle("muted", isMuted);
    btn.setAttribute("aria-pressed", isMuted);
  }
  if (iconOn) iconOn.style.display = isMuted ? "none" : "";
  if (iconOff) iconOff.style.display = isMuted ? "" : "none";
  if (label) label.textContent = isMuted ? "Unmute" : "Mute";
}

/**
 * 更新扬声器按钮状态
 * @param {boolean} speakerOn
 */
export function updateSpeakerButton(speakerOn) {
  const btn = $("#btn-speaker");
  const iconOn = $("#icon-speaker");
  const iconOff = $("#icon-earpiece");
  const label = $("#speaker-label");
  
  if (btn) btn.classList.toggle("speaker-off", !speakerOn);
  if (iconOn) iconOn.style.display = speakerOn ? "" : "none";
  if (iconOff) iconOff.style.display = speakerOn ? "none" : "";
  if (label) label.textContent = speakerOn ? "Speaker" : "Earpiece";
}

/**
 * 显示分享链接
 * @param {string} link
 */
export function showShareLink(link) {
  const input = $("#share-link");
  if (input) input.value = link;
}

/**
 * 设置断开连接屏幕内容
 * @param {string} reason
 * @param {boolean} canRetry
 */
export function setDisconnectedScreen(reason, canRetry = true) {
  const reasonEl = $("#disconnect-reason");
  const titleEl = $("#disconnect-title");
  const retryBtn = $("#btn-retry");
  
  if (reasonEl) reasonEl.textContent = reason || "The call has ended";
  if (titleEl) {
    titleEl.textContent = (reason && (reason.includes("lost") || reason.includes("failed")))
      ? "Connection Lost"
      : "Call Ended";
  }
  if (retryBtn) retryBtn.style.display = canRetry ? "" : "none";
}

export default screenManager;
export { ScreenManager };
