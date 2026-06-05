/**
 * iSay PeerJS 连接管理
 * 处理 PeerJS 实例的创建、连接和生命周期
 */

import { ICE_CONFIG, PEER_ID, NETWORK, TIMEOUTS } from '../config.js';
import state from '../state.js';
import { logger } from '../utils/helpers.js';
import { setupDataConnection } from '../ui/chat.js';
import { handleIncomingCall, startHostScan, clearMeshScanTimer, clearHostScanTimer } from './mesh.js';

const log = logger.child('Peer');

/**
 * 附加 PeerJS 生命周期事件
 * @param {import('peerjs').Peer} p
 * @param {Function} onDisconnected
 */
export function attachPeerLifecycleHandlers(p, onDisconnected) {
  p.on("disconnected", () => {
    log.warn('PeerJS signaling disconnected');
    if (state.peer !== p || p.destroyed) return;
    
    let reconTries = 0;
    const doReconnect = () => {
      if (state.peer !== p || p.destroyed || !p.disconnected) return;
      reconTries++;
      try { p.reconnect(); } catch (_) {}
      
      if (reconTries < 3) {
        setTimeout(doReconnect, TIMEOUTS.SIGNALING_RECONNECT[reconTries - 1]);
      } else if (state.peerCount === 0 && state.currentToken) {
        if (onDisconnected) onDisconnected();
      }
    };
    
    setTimeout(doReconnect, 500);
  });
  
  p.on("close", () => {
    log.warn('PeerJS connection closed');
    if (state.peer === p) {
      state.clearAllPendingCalls();
    }
  });
  
  p.on("error", (err) => {
    log.error('PeerJS error:', err.type, err.message);
  });
  
  p.on("connection", (conn) => {
    setupDataConnection(conn);
  });
}

/**
 * 连接到房间
 * @param {string} token
 * @param {Object} callbacks
 * @param {Function} callbacks.onPeerConnected
 * @param {Function} callbacks.onAllPeersDisconnected
 * @param {Function} callbacks.onPhaseChange
 * @returns {Promise<Object>}
 */
export async function connectPeer(token, callbacks = {}) {
  state.currentToken = token;
  state.currentRole = null;
  state.currentPeerId = null;
  
  const { onPeerConnected, onAllPeersDisconnected, onPhaseChange } = callbacks;
  
  if (onPhaseChange) onPhaseChange('signaling');
  
  // 尝试成为 Host
  const hostId = PEER_ID.format.host(token);
  const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const p = new Peer(hostId, { debug: isDev ? 2 : 0, config: ICE_CONFIG });
  
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => { aborted = true; };
    connectPeer._abort = abort;
    
    const timeout = setTimeout(() => {
      if (aborted) return;
      if (!state.currentRole) {
        try { p.destroy(); } catch (_) {}
        reject(new Error("Connection timed out. Make sure the other person has the link open."));
      }
    }, 12000);
    
    attachPeerLifecycleHandlers(p, () => {
      if (onAllPeersDisconnected) onAllPeersDisconnected();
    });
    
    p.on("open", () => {
      state.currentRole = "host";
      state.currentPeerId = hostId;
      state.peer = p;
      
      if (onPhaseChange) onPhaseChange('ice');
      clearTimeout(timeout);
      
      // 监听所有来电
      p.on("call", (call) => {
        handleIncomingCall(call, onPeerConnected, onAllPeersDisconnected);
      });
      
      // Host 也扫描 Guest 槽位
      startHostScan(token, onPeerConnected, onAllPeersDisconnected);
      
      resolve({ role: "host" });
    });
    
    p.on("error", (err) => {
      if (aborted) {
        try { p.destroy(); } catch (_) {}
        return;
      }
      
      if (err.type === "unavailable-id" && !state.currentRole) {
        // Host 已被占用，成为 Guest
        p.destroy();
        becomeGuest(token, timeout, aborted, resolve, reject, callbacks);
      } else if (!state.currentRole) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

/**
 * 成为 Guest
 */
function becomeGuest(token, timeout, aborted, resolve, reject, callbacks) {
  const { onPeerConnected, onAllPeersDisconnected, onPhaseChange } = callbacks;
  const hostId = PEER_ID.format.host(token);
  
  let guestIdx = 0;
  
  const tryGuest = () => {
    if (aborted) {
      clearTimeout(timeout);
      reject(new Error("Cancelled."));
      return;
    }
    
    if (guestIdx >= NETWORK.MAX_PEERS) {
      clearTimeout(timeout);
      reject(new Error("Room is full."));
      return;
    }
    
    const guestId = PEER_ID.format.guest(token, guestIdx);
    const gp = new Peer(guestId, { debug: 0, config: ICE_CONFIG });
    
    attachPeerLifecycleHandlers(gp, () => {
      if (onAllPeersDisconnected) onAllPeersDisconnected();
    });
    
    gp.on("open", () => {
      state.currentRole = "guest";
      state.currentPeerId = guestId;
      state.peer = gp;
      
      if (onPhaseChange) onPhaseChange('ice');
      clearTimeout(timeout);
      
      gp.on("call", (call) => {
        handleIncomingCall(call, onPeerConnected, onAllPeersDisconnected);
      });
      
      // 连接到 Host
      setTimeout(() => {
        if (state.peer && state.peer.open) {
          initiateCall(hostId, {
            maxAttempts: NETWORK.HOST_RETRY_DELAYS.length,
            retryDelays: NETWORK.HOST_RETRY_DELAYS,
            required: true,
          }, onPeerConnected, onAllPeersDisconnected);
        }
      }, 400);
      
      // 主动扫描之前的 Guest
      for (let i = 0; i < guestIdx; i++) {
        const id = PEER_ID.format.guest(token, i);
        setTimeout(() => {
          if (state.peer && state.peer.open) {
            initiateCall(id, { maxAttempts: 1 }, onPeerConnected, onAllPeersDisconnected);
          }
        }, NETWORK.MESH_CONNECT_DELAY + i * 250);
      }
      
      resolve({ role: "guest" });
    });
    
    gp.on("error", (guestErr) => {
      if (aborted) {
        try { gp.destroy(); } catch (_) {}
        return;
      }
      
      if (guestErr.type === "unavailable-id") {
        gp.destroy();
        guestIdx++;
        tryGuest();
      } else {
        clearTimeout(timeout);
        reject(guestErr);
      }
    });
  };
  
  tryGuest();
}

/**
 * 断开 PeerJS 连接
 */
export function destroyPeer() {
  state.currentPeerId = null;
  state.clearAllPendingCalls();
  
  if (state.peer) {
    try { state.peer.destroy(); } catch (_) {}
    state.peer = null;
  }
}

/**
 * 重新连接
 * @param {Object} callbacks
 */
export async function reconnect(callbacks) {
  clearMeshScanTimer();
  clearHostScanTimer();
  
  destroyPeer();
  
  if (state.currentToken) {
    try {
      await connectPeer(state.currentToken, callbacks);
    } catch (err) {
      log.error('Reconnection failed:', err);
      throw err;
    }
  }
}

export default {
  attachPeerLifecycleHandlers,
  connectPeer,
  destroyPeer,
  reconnect,
};
