/**
 * iSay 网络迁移
 * 网络切换检测和 ICE 重启
 */

import { NETWORK, TIMEOUTS } from '../config.js';
import state from '../state.js';
import { logger } from '../utils/helpers.js';
import { showToast } from '../ui/toast.js';

const log = logger.child('Network');

/**
 * 设置网络迁移监听
 */
export function setupNetworkMigration() {
  if (!navigator.connection || state.networkMigrationInitialized) return;
  
  state.networkMigrationInitialized = true;
  let lastType = navigator.connection.effectiveType;
  
  navigator.connection.addEventListener("change", () => {
    const newType = navigator.connection.effectiveType;
    if (newType !== lastType) {
      lastType = newType;
      log.info('Network type changed:', newType);
      showToast(`Network: ${newType}. Adjusting...`);
      
      // 对所有连接尝试 ICE 重启
      for (const [, info] of state.peers) {
        attemptICERestart(info.call?.peerConnection);
      }
    }
  });
}

/**
 * 尝试 ICE 重启
 * @param {RTCPeerConnection} pc
 * @returns {boolean}
 */
export function attemptICERestart(pc) {
  const target = pc || (state.peers.values().next().value?.call?.peerConnection);
  if (!target) return false;
  
  const now = Date.now();
  const qos = state.getQoSState(target);
  
  // 冷却时间检查
  if (now - qos.lastIceRestart < NETWORK.ICE_RESTART_COOLDOWN) return false;
  
  qos.lastIceRestart = now;
  
  try {
    target.restartIce();
    log.info('ICE restart triggered');
    return true;
  } catch (err) {
    log.warn('restartIce failed:', err);
    return false;
  }
}

/**
 * 设置连接状态监听
 * @param {RTCPeerConnection} pc
 * @param {Function} onReconnectNeeded
 */
export function monitorConnectionState(pc, onReconnectNeeded) {
  if (!pc || pc._isayMonitored) return;
  pc._isayMonitored = true;
  
  setupNetworkMigration();
  
  let disconnectedTimer = null;
  let connectingTimer = null;
  
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    log.debug('peer connectionState:', state);
    
    if (state === "failed") {
      clearTimers();
      if (onReconnectNeeded) onReconnectNeeded();
    } else if (state === "disconnected") {
      if (!disconnectedTimer) {
        disconnectedTimer = setTimeout(() => {
          disconnectedTimer = null;
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            log.warn('Peer disconnected for 5s, triggering ICE restart');
            attemptICERestart(pc);
          }
        }, TIMEOUTS.DISCONNECTED_ICE_RESTART);
      }
    } else if (state === "connected") {
      clearTimers();
    } else if (state === "connecting") {
      if (!connectingTimer) {
        connectingTimer = setTimeout(() => {
          connectingTimer = null;
          if (pc.connectionState === "connecting" || pc.connectionState === "disconnected") {
            log.warn('Peer stuck in connecting for 15s, triggering ICE restart');
            attemptICERestart(pc);
          }
        }, TIMEOUTS.CONNECTING_ICE_RESTART);
      }
    }
  };
  
  pc.oniceconnectionstatechange = () => {
    const iceState = pc.iceConnectionState;
    log.debug('peer iceConnectionState:', iceState);
    
    if (iceState === "connected" || iceState === "completed") {
      state.reconnectAttempts = 0;
      state.getQoSState(pc).bitrateAppliedOnce = false;
    } else if (iceState === "failed") {
      if (onReconnectNeeded) onReconnectNeeded();
    }
  };
  
  pc.onicegatheringstatechange = () => {
    log.debug('peer iceGatheringState:', pc.iceGatheringState);
  };
  
  pc.onicecandidateerror = (err) => {
    log.warn('ICE candidate error:', {
      url: err.url,
      code: err.errorCode,
      text: err.errorText,
    });
  };
  
  pc.onsignalingstatechange = () => {
    log.debug('peer signalingState:', pc.signalingState);
  };
  
  function clearTimers() {
    if (disconnectedTimer) {
      clearTimeout(disconnectedTimer);
      disconnectedTimer = null;
    }
    if (connectingTimer) {
      clearTimeout(connectingTimer);
      connectingTimer = null;
    }
  }
}

export default {
  setupNetworkMigration,
  attemptICERestart,
  monitorConnectionState,
};
