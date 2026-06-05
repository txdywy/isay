/**
 * iSay 音频可视化
 * Canvas 频谱显示和说话检测
 */

import { $, debounce } from '../utils/helpers.js';
import { AUDIO } from '../config.js';
import state from '../state.js';

/**
 * 初始化音频可视化
 */
export function initAudioViz() {
  if (!state.audioCtx) {
    state.ensureAudioContext();
  }
  
  if (!state.localStream || !state.audioCtx) return;
  
  const localSrc = state.audioCtx.createMediaStreamSource(state.localStream);
  state.localAnalyser = state.audioCtx.createAnalyser();
  state.localAnalyser.fftSize = AUDIO.VISUALIZER.FFT_SIZE;
  state.localAnalyser.smoothingTimeConstant = AUDIO.VISUALIZER.SMOOTHING;
  localSrc.connect(state.localAnalyser);
  
  drawVisualizer();
  setupCanvasResize();
}

/**
 * 设置 Canvas 窗口大小调整
 */
function setupCanvasResize() {
  const onResize = debounce(() => {
    state.invalidateCanvasCache();
    if (state.vizRAF) {
      cancelAnimationFrame(state.vizRAF);
      state.vizRAF = null;
    }
    drawVisualizer();
  }, 150);
  
  window.addEventListener("resize", onResize);
  if (screen.orientation) {
    screen.orientation.addEventListener("change", onResize);
  }
}

/**
 * 绘制可视化
 */
export function drawVisualizer() {
  const canvas = $("#visualizer");
  if (!canvas) return;
  
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) {
    requestAnimationFrame(() => drawVisualizer());
    return;
  }
  
  // 使用缓存的尺寸或更新
  if (!state.cachedCanvasSize) {
    state.updateCanvasCache(canvas);
  }
  
  const { logicalW, logicalH } = state.cachedCanvasSize;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.scale(dpr, dpr);
  
  const bufLen = state.localAnalyser ? state.localAnalyser.frequencyBinCount : 128;
  const localData = state.ensureVizBuffer('local', bufLen);
  const remoteMerged = state.ensureVizBuffer('remote', bufLen);
  
  function draw() {
    state.vizRAF = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, logicalW, logicalH);
    
    if (state.localAnalyser) {
      state.localAnalyser.getByteFrequencyData(localData);
    }
    
    // 合并所有远端 peer 频率数据
    remoteMerged.fill(0);
    for (const [pid, info] of state.peers) {
      if (info.analyser) {
        const tmp = state.ensurePeerBuffer(pid, bufLen);
        info.analyser.getByteFrequencyData(tmp);
        for (let i = 0; i < bufLen; i++) {
          if (tmp[i] > remoteMerged[i]) remoteMerged[i] = tmp[i];
        }
      }
    }
    
    // 清理已断开 peer 的缓冲
    state.cleanupPeerBuffers();
    
    const barCount = AUDIO.VISUALIZER.BAR_COUNT;
    const barW = (logicalW - (barCount - 1) * AUDIO.VISUALIZER.BAR_GAP) / barCount;
    const step = Math.floor(bufLen / barCount);
    
    drawBars(ctx, remoteMerged, barCount, barW, step, logicalW, logicalH, "#22c55e", 0.7, true);
    drawBars(ctx, localData, barCount, barW, step, logicalW, logicalH, "#4f9cf7", 0.8, false);
    updateSpeakingIndicators();
  }
  
  draw();
}

/**
 * 绘制频谱柱状图
 */
function drawBars(ctx, data, count, barW, step, W, H, color, alpha, fromBottom) {
  const halfH = H / 2;
  const centerY = fromBottom ? H : 0;
  
  for (let i = 0; i < count; i++) {
    const val = data[i * step] / 255;
    const barH = Math.max(2, val * halfH * 0.9);
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha * (0.3 + val * 0.7);
    const x = i * (barW + 2);
    
    if (fromBottom) {
      roundRect(ctx, x, centerY - barH, barW, barH, Math.min(barW / 2, 3));
    } else {
      roundRect(ctx, x, centerY, barW, barH, Math.min(barW / 2, 3));
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * 绘制圆角矩形
 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.fill();
}

/**
 * 获取 RMS 能量
 * @param {AnalyserNode} analyser
 * @returns {number}
 */
export function getRMS(analyser) {
  if (!analyser) return 0;
  
  const size = analyser.fftSize;
  const buffer = state.getRMSBuffer(size);
  analyser.getByteTimeDomainData(buffer);
  
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const v = (buffer[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / size);
}

/**
 * 更新说话指示器
 */
export function updateSpeakingIndicators() {
  const localRMS = getRMS(state.localAnalyser);
  const localLabel = $("#label-local");
  if (localLabel) {
    localLabel.classList.toggle("speaking", localRMS > AUDIO.VISUALIZER.SPEAKING_THRESHOLD && !state.isMuted);
  }
  
  // 检查是否有任何远端 peer 在说话
  let anyRemoteSpeaking = false;
  for (const [, info] of state.peers) {
    if (getRMS(info.analyser) > AUDIO.VISUALIZER.SPEAKING_THRESHOLD) {
      anyRemoteSpeaking = true;
      break;
    }
  }
  
  const remoteLabel = $("#label-remote");
  if (remoteLabel) {
    remoteLabel.classList.toggle("speaking", anyRemoteSpeaking);
  }
}

/**
 * 停止音频可视化
 */
export function stopAudioViz() {
  if (state.vizRAF) {
    cancelAnimationFrame(state.vizRAF);
    state.vizRAF = null;
  }
  
  state.localAnalyser = null;
  state.invalidateCanvasCache();
  state.clearVizBuffers();
  
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
  }
}

export default {
  initAudioViz,
  drawVisualizer,
  getRMS,
  updateSpeakingIndicators,
  stopAudioViz,
};
