/**
 * iSay 状态管理
 * 集中管理应用状态，提供响应式更新
 */

class StateManager {
  constructor() {
    // PeerJS 实例
    this.peer = null;
    this.localStream = null;
    
    // 通话状态
    this.isMuted = false;
    this.callStartTime = null;
    this.durationTimer = null;
    
    // 音频相关
    this.audioCtx = null;
    this.localAnalyser = null;
    this.vizRAF = null;
    this.audioUnlocked = false;
    
    // 网络相关
    this.statsInterval = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.networkMigrationInitialized = false;
    
    // 房间相关
    this.currentToken = null;
    this.currentRole = null;  // "host" or "guest"
    this.currentPeerId = null;
    
    // UI 状态
    this.wakeLock = null;
    this.lastQualityScore = -1;
    this.currentAudioOutput = "default";
    this.speakerOn = true;
    
    // Mesh 扫描
    this.meshScanTimer = null;
    this.hostScanTimer = null;
    this.lastMeshScanTime = 0;
    
    // 数据连接
    this.dataConns = new Map();  // peerId -> DataConnection
    this.peers = new Map();      // peerId -> { call, remoteAudio, analyser }
    this.pendingCalls = new Map(); // peerId -> { call, timer, attempts }
    this.qosByConnection = new WeakMap();
    
    // QoS 监控
    this.statsPaused = false;
    this.statsInFlight = false;
    this.glitchStats = { lastTs: 0 };
    
    // 可视化缓冲
    this.vizBuffers = {
      local: null,
      remote: null,
      peerTmp: new Map(),
    };
    this.rmsBuffer = new Uint8Array(256);
    
    // Canvas 缓存
    this.cachedCanvasSize = null;
    
    // 定时器管理
    this.timers = new Map();
    
    // 事件监听器
    this._listeners = new Map();
  }
  
  // ========== 事件系统 ==========
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }
  
  off(event, callback) {
    const listeners = this._listeners.get(event);
    if (listeners) listeners.delete(callback);
  }
  
  emit(event, data) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          console.error(`[State] Event handler error for ${event}:`, err);
        }
      });
    }
  }
  
  // ========== 定时器管理 ==========
  setTimer(id, fn, delay, interval = false) {
    this.clearTimer(id);
    const timer = interval ? setInterval(fn, delay) : setTimeout(fn, delay);
    this.timers.set(id, { timer, interval });
  }
  
  clearTimer(id) {
    const entry = this.timers.get(id);
    if (entry) {
      entry.interval ? clearInterval(entry.timer) : clearTimeout(entry.timer);
      this.timers.delete(id);
    }
  }
  
  clearAllTimers() {
    for (const id of this.timers.keys()) {
      this.clearTimer(id);
    }
  }
  
  // ========== 状态重置 ==========
  reset() {
    this.currentToken = null;
    this.currentRole = null;
    this.currentPeerId = null;
    this.isMuted = false;
    this.speakerOn = true;
    this.currentAudioOutput = "default";
    this.reconnectAttempts = 0;
    this.lastMeshScanTime = 0;
    this.lastQualityScore = -1;
  }
  
  resetCallState() {
    this.callStartTime = null;
    this.durationTimer = null;
    this.reconnectAttempts = 0;
    this.statsPaused = false;
    this.statsInFlight = false;
  }
  
  // ========== Peer 管理 ==========
  addPeer(peerId, call, remoteAudio, analyser) {
    this.peers.set(peerId, { call, remoteAudio, analyser });
    this.emit('peer:add', { peerId, peerCount: this.peers.size });
  }
  
  removePeer(peerId) {
    const info = this.peers.get(peerId);
    if (info) {
      this.peers.delete(peerId);
      this.emit('peer:remove', { peerId, peerCount: this.peers.size });
    }
    return info;
  }
  
  getPeer(peerId) {
    return this.peers.get(peerId);
  }
  
  hasPeer(peerId) {
    return this.peers.has(peerId);
  }
  
  get peerCount() {
    return this.peers.size;
  }
  
  // ========== 数据连接管理 ==========
  addDataConn(peerId, conn) {
    this.dataConns.set(peerId, conn);
    this.emit('dataconn:add', { peerId });
  }
  
  removeDataConn(peerId) {
    this.dataConns.delete(peerId);
    this.emit('dataconn:remove', { peerId });
  }
  
  // ========== Pending Calls 管理 ==========
  addPendingCall(peerId, call, timer, attempts) {
    this.pendingCalls.set(peerId, { call, timer, attempts });
  }
  
  removePendingCall(peerId) {
    const pending = this.pendingCalls.get(peerId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCalls.delete(peerId);
    }
    return pending;
  }
  
  clearAllPendingCalls() {
    for (const peerId of this.pendingCalls.keys()) {
      this.removePendingCall(peerId);
    }
  }
  
  // ========== QoS 状态 ==========
  getQoSState(pc) {
    let state = this.qosByConnection.get(pc);
    if (!state) {
      state = { prevStats: {}, consecBad: 0, bitrateAppliedOnce: false, lastIceRestart: 0 };
      this.qosByConnection.set(pc, state);
    }
    return state;
  }
  
  // ========== 音频上下文 ==========
  ensureAudioContext() {
    if (!this.audioCtx) {
      try {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
      } catch (err) {
        console.error('[State] Failed to create AudioContext:', err);
        return null;
      }
    }
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }
  
  // ========== Canvas 缓存 ==========
  updateCanvasCache(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    this.cachedCanvasSize = {
      W: rect.width * dpr,
      H: rect.height * dpr,
      logicalW: rect.width,
      logicalH: rect.height,
    };
    canvas.width = this.cachedCanvasSize.W;
    canvas.height = this.cachedCanvasSize.H;
    return this.cachedCanvasSize;
  }
  
  invalidateCanvasCache() {
    this.cachedCanvasSize = null;
  }
  
  // ========== 可视化缓冲管理 ==========
  ensureVizBuffer(key, size) {
    const buffers = this.vizBuffers;
    if (key === 'local') {
      if (!buffers.local || buffers.local.length !== size) {
        buffers.local = new Uint8Array(size);
      }
      return buffers.local;
    } else if (key === 'remote') {
      if (!buffers.remote || buffers.remote.length !== size) {
        buffers.remote = new Uint8Array(size);
      }
      return buffers.remote;
    }
    return null;
  }
  
  ensurePeerBuffer(peerId, size) {
    let tmp = this.vizBuffers.peerTmp.get(peerId);
    if (!tmp || tmp.length !== size) {
      tmp = new Uint8Array(size);
      this.vizBuffers.peerTmp.set(peerId, tmp);
    }
    return tmp;
  }
  
  cleanupPeerBuffers() {
    for (const pid of this.vizBuffers.peerTmp.keys()) {
      if (!this.peers.has(pid)) {
        this.vizBuffers.peerTmp.delete(pid);
      }
    }
  }
  
  clearVizBuffers() {
    this.vizBuffers.local = null;
    this.vizBuffers.remote = null;
    this.vizBuffers.peerTmp.clear();
  }
  
  // ========== RMS 缓冲 ==========
  getRMSBuffer(size) {
    if (this.rmsBuffer.length < size) {
      this.rmsBuffer = new Uint8Array(size);
    }
    return this.rmsBuffer;
  }
}

// 单例导出
const state = new StateManager();
export default state;
export { StateManager };
