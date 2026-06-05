/**
 * iSay Mesh 网络管理
 * 处理 P2P Mesh 网络的连接、扫描和管理
 */

import { NETWORK, TIMEOUTS, PEER_ID } from '../config.js';
import state from '../state.js';
import { logger } from '../utils/helpers.js';
import { showToast } from '../ui/toast.js';
import { optimizeAudioConnection } from '../audio/stream.js';
import { monitorConnectionState } from './network.js';
import { setupDataConnection } from '../ui/chat.js';

const log = logger.child('Mesh');

/**
 * 处理来电
 * @param {import('peerjs').MediaConnection} call
 * @param {Function} onPeerConnected
 * @param {Function} onAllPeersDisconnected
 */
export function handleIncomingCall(call, onPeerConnected, onAllPeersDisconnected) {
  if (state.hasPeer(call.peer)) {
    try { call.close(); } catch (_) {}
    return;
  }
  
  optimizeAudioConnection(call);
  monitorConnectionState(call.peerConnection, () => scheduleReconnect(onAllPeersDisconnected));
  
  // 防止僵尸通话
  let streamTimer = null;
  const clearStreamTimer = () => {
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
  };
  
  call.on("stream", (remoteStream) => {
    clearStreamTimer();
    addPeer(call.peer, call, remoteStream, onPeerConnected);
  });
  
  call.on("close", () => {
    clearStreamTimer();
    removePeer(call.peer, false, onAllPeersDisconnected);
  });
  
  call.on("error", (err) => {
    clearStreamTimer();
    log.warn('Incoming call error:', call.peer, err);
    removePeer(call.peer, true, onAllPeersDisconnected);
  });
  
  // Safari/PeerJS 流事件丢失恢复
  const pc = call.peerConnection;
  if (pc) {
    const recoverStream = () => {
      if (state.hasPeer(call.peer)) return;
      if ((pc.connectionState === "connected" || pc.connectionState === "connecting") && pc.getReceivers) {
        const receivers = pc.getReceivers().filter(
          (r) => r.track && r.track.kind === "audio" && r.track.readyState !== "ended"
        );
        if (receivers.length > 0) {
          log.warn('Incoming call stream event missed, recovering:', call.peer);
          addPeer(call.peer, call, new MediaStream(receivers.map((r) => r.track)), onPeerConnected);
        }
      }
    };
    setTimeout(recoverStream, TIMEOUTS.STREAM_RECOVER[0]);
    setTimeout(recoverStream, TIMEOUTS.STREAM_RECOVER[1]);
  }
  
  // 应答
  const doAnswer = () => {
    if (!state.localStream) {
      setTimeout(doAnswer, 100);
      return;
    }
    
    const tracks = state.localStream.getAudioTracks();
    log.debug('Answering call:', call.peer, 'tracks:', tracks.length);
    
    try {
      call.answer(state.localStream);
      
      // 超时保护
      streamTimer = setTimeout(() => {
        if (!state.hasPeer(call.peer)) {
          log.warn('Incoming call stream timeout:', call.peer);
          try { call.close(); } catch (_) {}
        }
      }, NETWORK.CALL_STREAM_TIMEOUT);
    } catch (err) {
      log.warn('Answer failed:', call.peer, err);
      try { call.close(); } catch (_) {}
    }
  };
  
  doAnswer();
}

/**
 * 发起通话
 * @param {string} targetPeerId
 * @param {Object} options
 * @param {Function} onPeerConnected
 * @param {Function} onAllPeersDisconnected
 */
export async function initiateCall(targetPeerId, options = {}, onPeerConnected, onAllPeersDisconnected) {
  if (!state.peer || !state.peer.open || targetPeerId === state.peer.id) return;
  if (state.hasPeer(targetPeerId) || state.pendingCalls.has(targetPeerId)) return;
  if (state.pendingCalls.size >= NETWORK.PENDING_CALLS_LIMIT) return;
  
  // 同时建立数据通道
  if (!state.dataConns.has(targetPeerId)) {
    const conn = state.peer.connect(targetPeerId, { reliable: true });
    setupDataConnection(conn);
  }
  
  // Safari/iOS 后台可能停止轨道
  if (!state.localStream || state.localStream.getAudioTracks().length === 0 ||
      state.localStream.getAudioTracks().every((t) => !t.enabled || t.readyState === "ended")) {
    const { reacquireLocalStream } = await import('../audio/stream.js');
    const success = await reacquireLocalStream();
    if (!success) return;
  }
  
  const attempt = options.attempt || 1;
  const maxAttempts = options.maxAttempts || 1;
  const call = state.peer.call(targetPeerId, state.localStream);
  
  if (!call) {
    retryCall(targetPeerId, options, onPeerConnected, onAllPeersDisconnected);
    return;
  }
  
  log.debug('Dialing peer:', targetPeerId, 'attempt:', attempt);
  
  // PeerJS 异步创建 peerConnection，多次尝试优化
  [0, 50, 150, 400].forEach((ms) => {
    setTimeout(() => {
      optimizeAudioConnection(call);
      monitorConnectionState(call.peerConnection, () => scheduleReconnect(onAllPeersDisconnected));
    }, ms);
  });
  
  // 超时保护
  const timer = setTimeout(() => {
    if (state.hasPeer(targetPeerId)) return;
    log.warn('Call stream timeout:', targetPeerId, 'attempt:', attempt);
    state.removePendingCall(targetPeerId);
    
    if (attempt < maxAttempts) {
      const retryDelays = options.retryDelays || [];
      const retryDelay = retryDelays[attempt] ?? TIMEOUTS.CALL_RETRY_DELAY;
      setTimeout(() => {
        initiateCall(targetPeerId, { ...options, attempt: attempt + 1 }, onPeerConnected, onAllPeersDisconnected);
      }, retryDelay);
    } else if (options.required && state.peerCount === 0 && state.currentToken) {
      startMeshScan(state.currentToken, onPeerConnected, onAllPeersDisconnected);
    }
  }, NETWORK.CALL_STREAM_TIMEOUT);
  
  state.addPendingCall(targetPeerId, call, timer, attempt);
  
  call.on("stream", (remoteStream) => {
    addPeer(targetPeerId, call, remoteStream, onPeerConnected);
  });
  
  call.on("close", () => {
    state.removePendingCall(targetPeerId);
    removePeer(targetPeerId, false, onAllPeersDisconnected);
  });
  
  call.on("error", (err) => {
    log.warn('Outgoing call error:', targetPeerId, err);
    state.removePendingCall(targetPeerId);
    removePeer(targetPeerId, true, onAllPeersDisconnected);
    
    if (!state.hasPeer(targetPeerId) && attempt < maxAttempts) {
      retryCall(targetPeerId, options, onPeerConnected, onAllPeersDisconnected);
    } else if (options.required && state.peerCount === 0 && state.currentToken) {
      startMeshScan(state.currentToken, onPeerConnected, onAllPeersDisconnected);
    }
  });
  
  // 流事件丢失恢复
  const pc = call.peerConnection;
  if (pc) {
    const recoverStream = () => {
      if (state.hasPeer(targetPeerId)) return;
      if ((pc.connectionState === "connected" || pc.connectionState === "connecting") && pc.getReceivers) {
        const receivers = pc.getReceivers().filter(
          (r) => r.track && r.track.kind === "audio" && r.track.readyState !== "ended"
        );
        if (receivers.length > 0) {
          log.warn('Outgoing call stream event missed, recovering:', targetPeerId);
          addPeer(targetPeerId, call, new MediaStream(receivers.map((r) => r.track)), onPeerConnected);
        }
      }
    };
    setTimeout(recoverStream, TIMEOUTS.STREAM_RECOVER[0]);
    setTimeout(recoverStream, TIMEOUTS.STREAM_RECOVER[1]);
  }
}

/**
 * 重试通话
 */
function retryCall(targetPeerId, options, onPeerConnected, onAllPeersDisconnected) {
  const attempt = options.attempt || 1;
  const maxAttempts = options.maxAttempts || 1;
  if (attempt >= maxAttempts) return;
  
  const retryDelays = options.retryDelays || [];
  const retryDelay = retryDelays[attempt] ?? TIMEOUTS.CALL_RETRY_DELAY;
  setTimeout(() => {
    initiateCall(targetPeerId, { ...options, attempt: attempt + 1 }, onPeerConnected, onAllPeersDisconnected);
  }, retryDelay);
}

/**
 * 添加 peer
 */
function addPeer(peerId, call, stream, onPeerConnected) {
  state.removePendingCall(peerId);
  
  if (state.hasPeer(peerId)) {
    try { call.close(); } catch (_) {}
    return;
  }
  
  if (state.peerCount >= NETWORK.MAX_PEERS) {
    call.close();
    showToast("Room is full (max 8 people).");
    return;
  }
  
  // 创建远端音频元素
  const remoteAudio = new Audio();
  remoteAudio.srcObject = stream;
  remoteAudio.autoplay = true;
  remoteAudio.volume = state.speakerOn ? 0.85 : 1.0;
  
  if (state.currentAudioOutput !== "default" && remoteAudio.setSinkId) {
    remoteAudio.setSinkId(state.currentAudioOutput).catch(() => {});
  }
  
  // 创建可视化分析器
  let analyser = null;
  if (state.audioCtx) {
    try {
      const vizStream = stream.clone();
      const src = state.audioCtx.createMediaStreamSource(vizStream);
      analyser = state.audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      src.connect(analyser);
    } catch (err) {
      log.warn('WebAudio analyser failed:', err);
    }
  }
  
  state.addPeer(peerId, call, remoteAudio, analyser);
  
  call.on("close", () => removePeer(peerId, false, null));
  call.on("error", () => removePeer(peerId, true, null));
  
  if (state.peerCount === 1 && onPeerConnected) {
    onPeerConnected();
  }
}

/**
 * 移除 peer
 */
function removePeer(peerId, closeCall = true, onAllPeersDisconnected) {
  const info = state.removePeer(peerId);
  if (!info) return;
  
  if (closeCall) {
    try { info.call.close(); } catch (_) {}
  }
  
  if (info.remoteAudio) {
    info.remoteAudio.pause();
    info.remoteAudio.srcObject = null;
    if (info.remoteAudio.parentNode) {
      info.remoteAudio.parentNode.removeChild(info.remoteAudio);
    }
  }
  
  if (state.peerCount === 0 && state.currentToken && onAllPeersDisconnected) {
    onAllPeersDisconnected();
  }
}

/**
 * 关闭所有 peer 连接
 */
export function closeAllPeers() {
  state.clearAllPendingCalls();
  
  for (const [, info] of state.peers) {
    try { info.call.close(); } catch (_) {}
    if (info.remoteAudio) {
      info.remoteAudio.pause();
      info.remoteAudio.srcObject = null;
      if (info.remoteAudio.parentNode) {
        info.remoteAudio.parentNode.removeChild(info.remoteAudio);
      }
    }
  }
  
  state.peers.clear();
}

/**
 * 开始 Mesh 扫描
 */
export function startMeshScan(token, onPeerConnected, onAllPeersDisconnected) {
  if (!state.peer || !state.peer.open || state.peerCount > 0) return;
  
  const now = Date.now();
  if (now - state.lastMeshScanTime < TIMEOUTS.MESH_SCAN_THROTTLE) return;
  state.lastMeshScanTime = now;
  
  showToast("Still waiting for the other side. Retrying...", 2500);
  scanRoomPeers(token, onPeerConnected, onAllPeersDisconnected);
  
  if (state.meshScanTimer) return;
  
  state.meshScanTimer = setInterval(() => {
    if (!state.peer || !state.peer.open || state.peerCount > 0 || !state.currentToken) {
      clearMeshScanTimer();
      return;
    }
    scanRoomPeers(state.currentToken, onPeerConnected, onAllPeersDisconnected);
  }, NETWORK.MESH_SCAN_INTERVAL);
}

/**
 * 扫描房间内的 peer
 */
function scanRoomPeers(token, onPeerConnected, onAllPeersDisconnected) {
  if (!state.peer || !state.peer.open || !state.currentPeerId) return;
  
  const hostId = PEER_ID.format.host(token);
  initiateCall(hostId, { maxAttempts: 1 }, onPeerConnected, onAllPeersDisconnected);
  
  for (let i = 0; i < NETWORK.MAX_PEERS; i++) {
    const guestId = PEER_ID.format.guest(token, i);
    if (guestId !== state.currentPeerId) {
      initiateCall(guestId, { maxAttempts: 1 }, onPeerConnected, onAllPeersDisconnected);
    }
  }
}

/**
 * 开始 Host 扫描
 */
export function startHostScan(token, onPeerConnected, onAllPeersDisconnected) {
  if (!state.peer || !state.peer.open || state.currentRole !== "host") return;
  if (state.hostScanTimer) return;
  
  const doScan = () => {
    if (!state.peer || !state.peer.open || state.currentRole !== "host" || state.peerCount > 0) {
      clearHostScanTimer();
      return;
    }
    
    for (let i = 0; i < NETWORK.MAX_PEERS; i++) {
      const guestId = PEER_ID.format.guest(token, i);
      if (!state.hasPeer(guestId) && !state.pendingCalls.has(guestId)) {
        initiateCall(guestId, { maxAttempts: 1 }, onPeerConnected, onAllPeersDisconnected);
      }
    }
  };
  
  setTimeout(doScan, TIMEOUTS.HOST_SCAN_INITIAL);
  state.hostScanTimer = setInterval(doScan, NETWORK.MESH_SCAN_INTERVAL);
}

/**
 * 安排重连
 */
export function scheduleReconnect(onAllPeersDisconnected) {
  if (state.reconnectTimer) return;
  
  if (state.reconnectAttempts >= NETWORK.MAX_RECONNECT_ATTEMPTS) {
    if (onAllPeersDisconnected) {
      onAllPeersDisconnected("Connection lost. Max reconnection attempts reached.");
    }
    return;
  }
  
  // Mesh 中：只重连断开的 peer
  if (state.peerCount > 1) {
    const deadPeerIds = [];
    for (const [pid, info] of state.peers) {
      const pc = info.call?.peerConnection;
      if (!pc || pc.connectionState === "failed" || pc.iceConnectionState === "failed") {
        deadPeerIds.push(pid);
      }
    }
    
    if (deadPeerIds.length > 0) {
      for (const pid of deadPeerIds) {
        removePeer(pid, true, null);
        if (state.currentPeerId && state.currentToken) {
          setTimeout(() => {
            if (state.peer && state.peer.open) {
              initiateCall(pid, { maxAttempts: 2, retryDelays: [1000, 3000] }, null, onAllPeersDisconnected);
            }
          }, 500);
        }
      }
      if (state.peerCount > 0) return;
    }
  }
  
  const delay = NETWORK.RECONNECT_BACKOFF[Math.min(state.reconnectAttempts, NETWORK.RECONNECT_BACKOFF.length - 1)];
  
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectAttempts++;
    
    if (!state.currentToken) {
      if (onAllPeersDisconnected) onAllPeersDisconnected("Connection lost.");
      return;
    }
    
    closeAllPeers();
    // 主模块需要处理音频可视化和统计的停止
    state.emit('reconnect:needed');
  }, delay);
}

/**
 * 清除 Mesh 扫描定时器
 */
export function clearMeshScanTimer() {
  if (state.meshScanTimer) {
    clearInterval(state.meshScanTimer);
    state.meshScanTimer = null;
  }
}

/**
 * 清除 Host 扫描定时器
 */
export function clearHostScanTimer() {
  if (state.hostScanTimer) {
    clearInterval(state.hostScanTimer);
    state.hostScanTimer = null;
  }
}

/**
 * 清除重连定时器
 */
export function clearReconnectTimer() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

export {
  addPeer,
  removePeer,
};

export default {
  handleIncomingCall,
  initiateCall,
  closeAllPeers,
  startMeshScan,
  startHostScan,
  scheduleReconnect,
  clearMeshScanTimer,
  clearHostScanTimer,
  clearReconnectTimer,
};
