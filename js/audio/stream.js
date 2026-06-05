/**
 * iSay 音频流管理
 * 处理本地音频流的获取、停止和优化
 */

import { AUDIO, ERROR_MESSAGES } from '../config.js';
import state from '../state.js';
import { logger } from '../utils/helpers.js';

const log = logger.child('Audio');

/**
 * 获取本地音频流
 * @returns {Promise<MediaStream>}
 */
export async function getLocalStream() {
  if (state.localStream) return state.localStream;
  
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia(AUDIO.CONSTRAINTS);
    
    // 监听轨道结束事件
    state.localStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        log.warn('Microphone track ended');
        // 触发事件让主模块处理
        state.emit('audio:trackended');
      };
    });
    
    log.info('Local stream acquired');
    return state.localStream;
  } catch (err) {
    const errorInfo = ERROR_MESSAGES[err.name];
    if (errorInfo) {
      throw new Error(errorInfo.userMessage);
    }
    throw new Error("Microphone access denied.");
  }
}

/**
 * 停止本地音频流
 */
export function stopLocalStream() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    state.localStream = null;
    log.info('Local stream stopped');
  }
}

/**
 * 检查本地流是否有效
 * @returns {boolean}
 */
export function isLocalStreamValid() {
  if (!state.localStream) return false;
  const tracks = state.localStream.getAudioTracks();
  return tracks.length > 0 && tracks.some(t => t.enabled && t.readyState !== 'ended');
}

/**
 * 重新获取本地流（用于 iOS/Safari 后台恢复）
 * @returns {Promise<boolean>}
 */
export async function reacquireLocalStream() {
  if (isLocalStreamValid()) return true;
  
  try {
    log.warn('Re-acquiring local stream');
    state.localStream = null;
    await getLocalStream();
    return true;
  } catch (err) {
    log.error('Failed to re-acquire local stream:', err);
    return false;
  }
}

/**
 * 切换静音状态
 * @returns {boolean} 新的静音状态
 */
export function toggleMute() {
  if (!state.localStream) return state.isMuted;
  
  state.isMuted = !state.isMuted;
  state.localStream.getAudioTracks().forEach((track) => {
    track.enabled = !state.isMuted;
  });
  
  log.info('Mute toggled:', state.isMuted);
  return state.isMuted;
}

/**
 * 配置音频会话（iOS）
 */
export function configureAudioSession() {
  if ("audioSession" in navigator) {
    try {
      navigator.audioSession.type = state.speakerOn ? "play-and-record" : "voice-chat";
    } catch (err) {
      log.debug('audioSession configuration failed:', err);
    }
  }
}

/**
 * 切换扬声器/听筒
 * @returns {Promise<boolean>} 新的扬声器状态
 */
export async function toggleSpeaker() {
  state.speakerOn = !state.speakerOn;
  
  // iOS: use audioSession API
  configureAudioSession();
  
  // 调整远端音量
  for (const [, info] of state.peers) {
    if (info.remoteAudio) {
      info.remoteAudio.volume = state.speakerOn ? 0.85 : 1.0;
    }
  }
  
  // Desktop/Android: use setSinkId if available
  if ("setSinkId" in Audio.prototype) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === "audiooutput");
      let targetId = "default";
      
      if (!state.speakerOn) {
        const comm = outputs.find(d => /earpiece|communication/i.test(d.label));
        if (comm) targetId = comm.deviceId;
      } else {
        const speaker = outputs.find(d => /speaker/i.test(d.label) && !/earpiece/i.test(d.label));
        if (speaker) targetId = speaker.deviceId;
      }
      
      state.currentAudioOutput = targetId;
      
      for (const [, info] of state.peers) {
        if (info.remoteAudio && info.remoteAudio.setSinkId) {
          await info.remoteAudio.setSinkId(targetId);
        }
      }
      
      log.info('Audio output switched to:', targetId);
    } catch (err) {
      log.warn('Audio routing not available:', err);
    }
  }
  
  return state.speakerOn;
}

/**
 * 恢复所有音频（用于 iOS 解锁）
 */
export function tryResumeAllAudio() {
  if (state.audioCtx && state.audioCtx.state === "suspended") {
    state.audioCtx.resume().catch(() => {});
  }
  
  for (const [, info] of state.peers) {
    if (info.remoteAudio && info.remoteAudio.paused) {
      info.remoteAudio.play().catch(() => {});
    }
  }
}

/**
 * 优化音频连接参数
 * @param {import('peerjs').MediaConnection} call
 */
export function optimizeAudioConnection(call) {
  const tryOptimize = () => {
    const pc = call.peerConnection;
    if (!pc) {
      requestAnimationFrame(tryOptimize);
      return;
    }
    
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
    const receiver = pc.getReceivers().find((r) => r.track && r.track.kind === "audio");
    
    if (!sender && !receiver) {
      setTimeout(tryOptimize, 100);
      return;
    }
    
    // 优化发送端
    if (sender) {
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = AUDIO.BITRATE.HIGH;
        params.encodings[0].priority = "high";
        sender.setParameters(params).catch(() => {});
      } catch (err) {
        log.debug('Sender optimization failed:', err);
      }
    }
    
    // 优化接收端
    if (receiver && "jitterBufferTarget" in receiver) {
      try {
        receiver.jitterBufferTarget = AUDIO.JITTER_BUFFER.ULTRA_LOW;
      } catch (err) {
        log.debug('Receiver optimization failed:', err);
      }
    }
  };
  
  tryOptimize();
}

/**
 * 自适应码率调整
 * @param {RTCPeerConnection} pc
 * @param {number} loss
 * @param {number} jitter
 * @param {number} rtt
 */
export async function adaptAudioBitrate(pc, loss, jitter, rtt) {
  const qos = state.getQoSState(pc);
  if (!qos.bitrateAppliedOnce) {
    qos.bitrateAppliedOnce = true;
    return;
  }
  
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
  if (!sender) return;
  
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    
    let targetBitrate;
    if (loss > 10 || jitter > 100 || rtt > 0.5) {
      targetBitrate = AUDIO.BITRATE.LOW;
    } else if (loss > 3 || jitter > 50 || rtt > 0.3) {
      targetBitrate = AUDIO.BITRATE.MEDIUM;
    } else {
      targetBitrate = AUDIO.BITRATE.HIGH;
    }
    
    // Mesh 中根据人数限制码率
    const peerCount = state.peerCount + 1;
    if (peerCount > 4) targetBitrate = Math.min(targetBitrate, AUDIO.BITRATE.CAP_THRESHOLD_4);
    if (peerCount > 6) targetBitrate = Math.min(targetBitrate, AUDIO.BITRATE.CAP_THRESHOLD_6);
    
    params.encodings[0].maxBitrate = targetBitrate;
    params.encodings[0].priority = "high";
    await sender.setParameters(params);
  } catch (err) {
    log.debug('Bitrate adaptation failed:', err);
  }
}

/**
 * 配置抖动缓冲
 * @param {RTCPeerConnection} pc
 * @param {number} jitter
 */
export function configureJitterBuffer(pc, jitter) {
  if (jitter < 0) return;
  
  try {
    pc.getReceivers().forEach((receiver) => {
      if (receiver.track.kind === "audio" && "jitterBufferTarget" in receiver) {
        if (jitter < 15) {
          receiver.jitterBufferTarget = AUDIO.JITTER_BUFFER.ULTRA_LOW;
        } else if (jitter < 30) {
          receiver.jitterBufferTarget = AUDIO.JITTER_BUFFER.GOOD;
        } else if (jitter < 60) {
          receiver.jitterBufferTarget = AUDIO.JITTER_BUFFER.MODERATE;
        } else {
          receiver.jitterBufferTarget = AUDIO.JITTER_BUFFER.LOSSY;
        }
      }
    });
  } catch (err) {
    log.debug('Jitter buffer configuration failed:', err);
  }
}

/**
 * 记录音频延迟
 */
export function logAudioLatency() {
  if (!state.audioCtx) return;
  const base = (state.audioCtx.baseLatency || 0) * 1000;
  const output = (state.audioCtx.outputLatency || 0) * 1000;
  const total = Math.round(base + output);
  if (total > 0) {
    log.info(`Audio latency: ${total}ms`);
  }
}

export default {
  getLocalStream,
  stopLocalStream,
  isLocalStreamValid,
  reacquireLocalStream,
  toggleMute,
  configureAudioSession,
  toggleSpeaker,
  tryResumeAllAudio,
  optimizeAudioConnection,
  adaptAudioBitrate,
  configureJitterBuffer,
  logAudioLatency,
};
