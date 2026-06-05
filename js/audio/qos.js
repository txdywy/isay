/**
 * iSay QoS 监控
 * 连接质量监控和自适应调整
 */

import { QOS, QUALITY_LABELS } from '../config.js';
import state from '../state.js';
import { logger } from '../utils/helpers.js';
import { adaptAudioBitrate, configureJitterBuffer } from './stream.js';
import { showToast } from '../ui/toast.js';
import { updateMetrics, setConnType, setQuality } from '../ui/screens.js';

const log = logger.child('QoS');

let statsInterval = null;
let lastQualityScore = -1;

/**
 * 启动统计监控
 * @param {Function} onBadConnection - 连接质量差时的回调
 */
export function startStatsMonitor(onBadConnection) {
  if (statsInterval) return;
  
  statsInterval = setInterval(async () => {
    if (state.statsPaused) return;
    if (state.statsInFlight) return;
    
    state.statsInFlight = true;
    
    try {
      const connectedPeers = [...state.peers.values()]
        .map((info) => info.call?.peerConnection)
        .filter((pc) => pc && pc.connectionState !== "closed");
      
      if (!connectedPeers.length) {
        stopStatsMonitor();
        return;
      }
      
      const snapshots = await Promise.all(
        connectedPeers.map((pc) => collectConnectionStats(pc))
      );
      const validSnapshots = snapshots.filter(Boolean);
      
      if (!validSnapshots.length) return;
      
      // 计算最差指标
      const worstLatency = Math.max(...validSnapshots.map((s) => s.latency).filter((v) => v >= 0), -1);
      const worstJitter = Math.max(...validSnapshots.map((s) => s.jitter).filter((v) => v >= 0), -1);
      const worstLoss = Math.max(...validSnapshots.map((s) => s.loss).filter((v) => v >= 0), -1);
      
      updateMetrics(worstLatency, worstJitter, worstLoss);
      setConnType(validSnapshots.some((s) => s.isRelay) ? "relay" : "p2p");
      
      // 处理每个连接
      for (const snapshot of validSnapshots) {
        const { pc, latency, jitter, loss, rtt } = snapshot;
        const safeLoss = loss >= 0 ? loss : 0;
        const safeJitter = jitter >= 0 ? jitter : 0;
        
        adaptAudioBitrate(pc, safeLoss, safeJitter, rtt);
        configureJitterBuffer(pc, jitter);
        
        // 检查是否需要 ICE 重启
        const qos = state.getQoSState(pc);
        if (safeLoss > QOS.LOSS.CRITICAL || latency > QOS.LATENCY.BAD) {
          qos.consecBad++;
          if (qos.consecBad >= QOS.CONSEC_BAD_THRESHOLD) {
            if (onBadConnection) onBadConnection(pc);
            qos.consecBad = 0;
          }
        } else if (safeLoss < QOS.LOSS.GOOD && latency >= 0 && latency < QOS.LATENCY.WARN) {
          qos.consecBad = Math.max(0, qos.consecBad - 1);
        }
      }
    } catch (err) {
      log.error('Stats collection error:', err);
    } finally {
      state.statsInFlight = false;
    }
  }, QOS.STATS_INTERVAL);
}

/**
 * 收集连接统计
 * @param {RTCPeerConnection} pc
 * @returns {Promise<Object|null>}
 */
async function collectConnectionStats(pc) {
  try {
    const stats = await pc.getStats();
    const reports = new Map();
    stats.forEach((report) => reports.set(report.id, report));
    
    let currentPair = null;
    stats.forEach((report) => {
      if (report.type !== "candidate-pair" || report.state !== "succeeded") return;
      if (report.selected || report.nominated) currentPair = report;
      else if (!currentPair && report.currentRoundTripTime !== undefined) currentPair = report;
    });
    
    if (!currentPair) return null;
    
    const localCandidate = reports.get(currentPair.localCandidateId);
    const remoteCandidate = reports.get(currentPair.remoteCandidateId);
    const isRelay = localCandidate?.candidateType === "relay" || remoteCandidate?.candidateType === "relay";
    const rtt = currentPair.currentRoundTripTime || 0;
    const latency = rtt ? rtt * 1000 : -1;
    const qos = state.getQoSState(pc);
    
    let recvDelta = 0;
    let lostDelta = 0;
    let totalPackets = 0;
    let lostPackets = 0;
    let jitter = -1;
    
    stats.forEach((report) => {
      if (report.type !== "inbound-rtp" || report.kind !== "audio") return;
      
      const prev = qos.prevStats[report.id];
      if (prev) {
        const dRecv = Math.max(0, report.packetsReceived - prev.packetsReceived);
        const dLost = Math.max(0, (report.packetsLost || 0) - prev.packetsLost);
        recvDelta += dRecv;
        lostDelta += dLost;
        
        // 检测音频卡顿
        const dConcealed = Math.max(0, (report.concealedSamples || 0) - prev.concealedSamples);
        const dTotalSamples = Math.max(0, (report.totalSamplesReceived || 0) - prev.totalSamplesReceived);
        if (dTotalSamples > 0 && dConcealed > 0) {
          const glitchRate = dConcealed / dTotalSamples;
          if (glitchRate > QOS.GLITCH_RATE_THRESHOLD) {
            const now = Date.now();
            if (now - state.glitchStats.lastTs > QOS.GLITCH_COOLDOWN) {
              state.glitchStats.lastTs = now;
              showToast(`Audio stutter: ${(glitchRate * 100).toFixed(0)}% concealed`, 2500);
            }
          }
        }
      }
      
      totalPackets += report.packetsReceived + (report.packetsLost || 0);
      lostPackets += report.packetsLost || 0;
      if (report.jitter !== undefined) jitter = Math.max(jitter, report.jitter * 1000);
      
      qos.prevStats[report.id] = {
        packetsReceived: report.packetsReceived,
        packetsLost: report.packetsLost || 0,
        concealedSamples: report.concealedSamples || 0,
        totalSamplesReceived: report.totalSamplesReceived || 0,
      };
    });
    
    let loss = -1;
    if (recvDelta + lostDelta > 0) {
      loss = (lostDelta / (recvDelta + lostDelta)) * 100;
    } else if (totalPackets > 0) {
      loss = (lostPackets / totalPackets) * 100;
    }
    
    return { pc, latency, jitter, loss, rtt, isRelay };
  } catch (err) {
    log.debug('Stats collection failed:', err);
    return null;
  }
}

/**
 * 更新质量评级
 * @param {number} latency
 * @param {number} jitter
 * @param {number} loss
 */
export function updateQualityScore(latency, jitter, loss) {
  if (latency < 0) return;
  
  let score = 5;
  if (latency > QOS.LATENCY.EXCELLENT) score--;
  if (latency > QOS.LATENCY.WARN) score--;
  if (jitter > QOS.JITTER.WARN) score--;
  if (loss > QOS.LOSS.WARN) score--;
  if (loss > QOS.LOSS.BAD) score--;
  score = Math.max(1, score);
  
  const label = QUALITY_LABELS[score];
  setQuality(score, label);
  
  // 质量变化通知
  if (lastQualityScore >= 4 && score <= 2 && score > 0) {
    showToast("Quality degraded.");
  } else if (lastQualityScore <= 2 && score >= 4) {
    showToast("Quality restored.");
  }
  
  if (score > 0) lastQualityScore = score;
}

/**
 * 停止统计监控
 */
export function stopStatsMonitor() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  state.statsInFlight = false;
  lastQualityScore = -1;
}

/**
 * 暂停统计
 */
export function pauseStats() {
  state.statsPaused = true;
}

/**
 * 恢复统计
 */
export function resumeStats() {
  state.statsPaused = false;
}

export default {
  startStatsMonitor,
  stopStatsMonitor,
  updateQualityScore,
  pauseStats,
  resumeStats,
};
