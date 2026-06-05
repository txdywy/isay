/**
 * iSay 主入口
 * 整合所有模块，处理应用生命周期
 */

import { NETWORK, WORD_LISTS, BROWSER, ERROR_MESSAGES, TIMEOUTS } from './config.js';
import state from './state.js';
import { $, generateToken, sanitizeToken, haptic, formatDuration, announce, copyToClipboard, checkCompatibility, getTokenFromUrl, buildShareLink, unlockAudio, initGlobalErrorHandler, logger } from './utils/helpers.js';
import screenManager, { setPhase, updateCallStatusText, updateDurationDisplay, setConnType, setQuality, updateMetrics, updatePeerCount, updateMuteButton, updateSpeakerButton, showShareLink, setDisconnectedScreen } from './ui/screens.js';
import { showToast } from './ui/toast.js';
import chatManager from './ui/chat.js';
import { getLocalStream, stopLocalStream, toggleMute, configureAudioSession, toggleSpeaker, tryResumeAllAudio, logAudioLatency, isLocalStreamValid } from './audio/stream.js';
import { initAudioViz, stopAudioViz } from './audio/visualizer.js';
import { startStatsMonitor, stopStatsMonitor, updateQualityScore, pauseStats, resumeStats } from './audio/qos.js';
import { setupNetworkMigration, attemptICERestart } from './peer/network.js';
import { handleIncomingCall, closeAllPeers, startMeshScan, startHostScan, clearMeshScanTimer, clearHostScanTimer, clearReconnectTimer, scheduleReconnect } from './peer/mesh.js';
import { connectPeer, destroyPeer, reconnect } from './peer/connection.js';

const log = logger.child('Main');

// ========== QR Code 生成 ==========
function generateQR(text, imgEl, size) {
  if (!generateQR._loaded) {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/qrcode@latest/build/qrcode.min.js";
    script.onload = () => {
      generateQR._loaded = true;
      generateQR(text, imgEl, size);
    };
    script.onerror = () => {
      imgEl.style.display = "none";
    };
    document.head.appendChild(script);
    return;
  }
  
  try {
    QRCode.toDataURL(text, {
      width: size,
      margin: 2,
      color: { dark: "#4f9cf7", light: "#1a1a1a" },
      errorCorrectionLevel: "M",
    }, (err, url) => {
      if (!err && url) imgEl.src = url;
      else imgEl.style.display = "none";
    });
  } catch (err) {
    log.debug('QR generation failed:', err);
    imgEl.style.display = "none";
  }
}

// ========== 通话时长计时器 ==========
function startDurationTimer() {
  if (state.durationTimer) return;
  if (!state.callStartTime) state.callStartTime = Date.now();
  
  state.durationTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.callStartTime) / 1000);
    updateDurationDisplay(formatDuration(elapsed));
  }, 1000);
}

function stopDurationTimer() {
  if (state.durationTimer) {
    clearInterval(state.durationTimer);
    state.durationTimer = null;
  }
  state.callStartTime = null;
}

// ========== 屏幕常亮 ==========
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch (err) {
    log.debug('Wake lock request failed:', err);
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release();
    state.wakeLock = null;
  }
}

// ========== 复制分享链接 ==========
function copyShareLink() {
  const link = $("#share-link").value;
  const hint = $("#copy-hint");
  const btn = $("#btn-copy-link");
  
  const showCopied = () => {
    btn.classList.add("copied");
    hint.textContent = "Copied!";
    haptic(20);
    setTimeout(() => {
      btn.classList.remove("copied");
      hint.textContent = "";
    }, TIMEOUTS.COPY_FEEDBACK);
  };
  
  copyToClipboard(link).then(success => {
    if (success) showCopied();
    else hint.textContent = "Press Ctrl+C to copy";
  });
}

// ========== Peer 连接回调 ==========
const peerCallbacks = {
  onPeerConnected: () => {
    clearMeshScanTimer();
    setPhase("connected");
    startDurationTimer();
    requestWakeLock();
    screenManager.show("call");
    configureAudioSession();
    initAudioViz();
    logAudioLatency();
    startStatsMonitor((pc) => attemptICERestart(pc));
  },
  onAllPeersDisconnected: (reason) => {
    endCall(reason || "All peers disconnected.");
  },
  onPhaseChange: (phase) => {
    setPhase(phase);
  },
};

// ========== 加入房间 ==========
async function joinRoom(token) {
  if (typeof token !== "string") token = $("#token-input").value;
  token = sanitizeToken(token);
  
  if (!token) {
    $("#token-input").focus();
    return;
  }
  
  // 解锁自动播放
  unlockAudio();
  
  // 创建/恢复 AudioContext
  state.ensureAudioContext();
  
  setPhase("signaling");
  screenManager.show("waiting");
  showShareLink(buildShareLink(token));
  
  // 生成 QR 码
  const qrImg = $("#qr-img");
  if (qrImg) generateQR(buildShareLink(token), qrImg, 160);
  
  try {
    await connectPeer(token, peerCallbacks);
    
    if (state.peerCount === 0) {
      // 等待其他人连接
    }
  } catch (err) {
    destroyPeer();
    stopLocalStream();
    setDisconnectedScreen(err.message || "Connection failed", !!state.currentToken);
    screenManager.show("disconnected");
  }
}

// ========== 结束通话 ==========
function endCall(reason) {
  log.info('Ending call:', reason);
  
  clearReconnectTimer();
  clearMeshScanTimer();
  clearHostScanTimer();
  stopDurationTimer();
  stopAudioViz();
  stopStatsMonitor();
  releaseWakeLock();
  
  state.reconnectAttempts = 0;
  closeAllPeers();
  stopLocalStream();
  destroyPeer();
  
  state.currentPeerId = null;
  state.lastMeshScanTime = 0;
  
  // 重置音频会话
  if ("audioSession" in navigator) {
    try { navigator.audioSession.type = "auto"; } catch (_) {}
  }
  
  setDisconnectedScreen(reason, !!state.currentToken);
  announce("Call ended. " + (reason || ""));
  screenManager.show("disconnected");
}

// ========== 重新开始 ==========
function restart() {
  closeAllPeers();
  stopLocalStream();
  stopAudioViz();
  stopStatsMonitor();
  clearReconnectTimer();
  clearMeshScanTimer();
  clearHostScanTimer();
  releaseWakeLock();
  
  state.reset();
  
  $("#token-input").value = generateToken(WORD_LISTS.ADJECTIVES, WORD_LISTS.NOUNS);
  updateMuteButton(false);
  updateSpeakerButton(true);
  screenManager.show("landing");
}

// ========== 事件绑定 ==========
function bindEvents() {
  // 加入房间
  $("#btn-join").addEventListener("click", () => joinRoom());
  $("#token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom();
  });
  
  // 复制链接
  $("#btn-copy-link").addEventListener("click", copyShareLink);
  
  // 取消等待
  $("#btn-cancel-wait").addEventListener("click", () => {
    if (connectPeer._abort) connectPeer._abort();
    destroyPeer();
    stopLocalStream();
    closeAllPeers();
    screenManager.show("landing");
  });
  
  // 静音
  $("#btn-mute").addEventListener("click", () => {
    const muted = toggleMute();
    updateMuteButton(muted);
    haptic(muted ? 30 : [20, 10, 20]);
    announce(muted ? "Muted" : "Unmuted");
  });
  
  // 扬声器
  const speakerBtn = $("#btn-speaker");
  if (speakerBtn) {
    speakerBtn.addEventListener("click", async () => {
      const on = await toggleSpeaker();
      updateSpeakerButton(on);
      showToast(on ? "Speaker mode" : "Earpiece mode", TIMEOUTS.TOAST_SHORT);
    });
  }
  
  // 挂断
  $("#btn-hangup").addEventListener("click", () => endCall("You ended the call"));
  
  // 重新开始
  $("#btn-restart").addEventListener("click", restart);
  
  // 重试
  $("#btn-retry").addEventListener("click", () => {
    if (state.currentToken) joinRoom(state.currentToken);
    else restart();
  });
  
  // 聊天发送
  const btnChatSend = $("#btn-chat-send");
  const chatInput = $("#chat-input");
  
  const sendChat = () => {
    const text = chatInput.value.trim();
    if (!text) return;
    chatManager.sendChat(text);
    chatInput.value = "";
  };
  
  btnChatSend?.addEventListener("click", sendChat);
  chatInput?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendChat();
  });
  
  // Ping
  const btnPing = $("#btn-ping");
  btnPing?.addEventListener("click", () => chatManager.sendPing());
  
  // 键盘快捷键
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.code === "Space" && state.peerCount > 0 && !e.repeat) {
      e.preventDefault();
      const muted = toggleMute();
      updateMuteButton(muted);
      haptic(muted ? 30 : [20, 10, 20]);
      announce(muted ? "Muted" : "Unmuted");
    }
  });
  
  // 全局点击恢复音频
  document.addEventListener("click", tryResumeAllAudio);
  document.addEventListener("touchstart", tryResumeAllAudio);
  
  // 前后台切换
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      resumeStats();
      if (state.peerCount > 0) {
        await requestWakeLock();
        if (state.audioCtx && state.audioCtx.state === "suspended") {
          state.audioCtx.resume().catch(() => {});
        }
      }
    } else {
      pauseStats();
    }
  });
  
  // 网络状态
  window.addEventListener('online', () => showToast('Network restored'));
  window.addEventListener('offline', () => showToast('Network disconnected, call may be interrupted'));
  
  // 音频轨道结束事件
  state.on('audio:trackended', () => {
    showToast("Microphone disconnected.");
    if (state.peerCount > 0) endCall("Microphone disconnected.");
  });
  
  // 重连事件
  state.on('reconnect:needed', async () => {
    stopAudioViz();
    stopStatsMonitor();
    screenManager.show("waiting");
    if (state.currentToken) showShareLink(buildShareLink(state.currentToken));
    setPhase("signaling");
    
    try {
      await reconnect(peerCallbacks);
    } catch (err) {
      endCall("Reconnection failed: " + (err.message || "unknown error"));
    }
  });
}

// ========== 初始化 ==========
function init() {
  log.info('Initializing iSay');
  
  // 初始化屏幕管理
  screenManager.init();
  
  // 检查兼容性
  const compatIssues = checkCompatibility();
  if (compatIssues.includes("RTCPeerConnection") || compatIssues.includes("getUserMedia")) {
    $("#screen-landing").innerHTML = `
      <div class="container">
        <h1>iSay</h1>
        <p class="subtitle" style="color:var(--danger)">Your browser does not support voice chat.</p>
        <p class="hint">Please use Chrome, Firefox, Edge, or Safari 15+.</p>
      </div>`;
    return;
  }
  
  if (compatIssues.includes("https")) {
    showToast("HTTPS required. Open via https:// or localhost.", TIMEOUTS.TOAST_LONG);
  }
  
  // 绑定事件
  bindEvents();
  
  // 初始化全局错误处理
  initGlobalErrorHandler((err) => {
    log.error('Global error:', err);
  });
  
  // 从 URL 获取 token
  const urlToken = getTokenFromUrl();
  if (urlToken) {
    joinRoom(urlToken);
  } else {
    $("#token-input").value = generateToken(WORD_LISTS.ADJECTIVES, WORD_LISTS.NOUNS);
  }
  
  // 生产环境设置日志级别
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    logger.setLevel('WARN');
  }
}

// 启动应用
init();
