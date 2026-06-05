/**
 * iSay 工具函数
 * DOM 操作、日志、通用工具
 */

// ========== DOM 缓存 ==========
const domCache = new Map();

/**
 * 缓存式 querySelector
 * @param {string} selector
 * @param {boolean} [forceRefresh=false]
 * @returns {Element|null}
 */
export function $(selector, forceRefresh = false) {
  if (!forceRefresh && domCache.has(selector)) {
    return domCache.get(selector);
  }
  const el = document.querySelector(selector);
  if (el) domCache.set(selector, el);
  return el;
}

/**
 * 清除 DOM 缓存
 * @param {string} [selector] - 指定选择器，不传则清除全部
 */
export function clearDomCache(selector) {
  if (selector) {
    domCache.delete(selector);
  } else {
    domCache.clear();
  }
}

/**
 * querySelectorAll 包装
 * @param {string} selector
 * @returns {NodeListOf<Element>}
 */
export function $$(selector) {
  return document.querySelectorAll(selector);
}

// ========== 日志系统 ==========
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
};

let currentLogLevel = LOG_LEVELS.DEBUG;

export const logger = {
  setLevel(level) {
    currentLogLevel = typeof level === 'string' ? (LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.DEBUG) : level;
  },
  
  debug(...args) {
    if (currentLogLevel <= LOG_LEVELS.DEBUG) {
      console.debug('[iSay]', ...args);
    }
  },
  
  info(...args) {
    if (currentLogLevel <= LOG_LEVELS.INFO) {
      console.info('[iSay]', ...args);
    }
  },
  
  warn(...args) {
    if (currentLogLevel <= LOG_LEVELS.WARN) {
      console.warn('[iSay]', ...args);
    }
  },
  
  error(...args) {
    if (currentLogLevel <= LOG_LEVELS.ERROR) {
      console.error('[iSay]', ...args);
    }
  },
  
  /**
   * 创建子日志器
   * @param {string} prefix
   */
  child(prefix) {
    return {
      debug: (...args) => logger.debug(`[${prefix}]`, ...args),
      info: (...args) => logger.info(`[${prefix}]`, ...args),
      warn: (...args) => logger.warn(`[${prefix}]`, ...args),
      error: (...args) => logger.error(`[${prefix}]`, ...args),
    };
  },
};

// ========== 生成 Token ==========
/**
 * 生成随机房间名
 * @param {string[]} adjectives
 * @param {string[]} nouns
 * @returns {string}
 */
export function generateToken(adjectives, nouns) {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}-${noun}-${num}`;
}

/**
 * 验证和清理 Token
 * @param {string} input
 * @param {Object} options
 * @param {number} [options.minLength=3]
 * @param {number} [options.maxLength=32]
 * @returns {string|null}
 */
export function sanitizeToken(input, options = {}) {
  const { minLength = 3, maxLength = 32 } = options;
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
  if (cleaned.length < minLength || cleaned.length > maxLength) return null;
  return cleaned;
}

// ========== 触觉反馈 ==========
/**
 * 触发震动反馈
 * @param {number|number[]} pattern
 */
export function haptic(pattern) {
  if ("vibrate" in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch (err) {
      logger.debug('Haptic feedback failed:', err);
    }
  }
}

// ========== 时间格式化 ==========
/**
 * 格式化秒数为 mm:ss
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// ========== 防抖 ==========
/**
 * 创建防抖函数
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ========== 节流 ==========
/**
 * 创建节流函数
 * @param {Function} fn
 * @param {number} limit
 * @returns {Function}
 */
export function throttle(fn, limit) {
  let inThrottle = false;
  return function (...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => { inThrottle = false; }, limit);
    }
  };
}

// ========== 屏幕阅读器公告 ==========
/**
 * 向屏幕阅读器发布公告
 * @param {string} text
 */
export function announce(text) {
  const el = $("#sr-announcer");
  if (el) el.textContent = text;
}

// ========== 剪贴板操作 ==========
/**
 * 复制文本到剪贴板
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return fallbackCopy(text);
  } catch (err) {
    logger.warn('Clipboard API failed, trying fallback:', err);
    return fallbackCopy(text);
  }
}

/**
 * 剪贴板回退方案
 * @param {string} text
 * @returns {boolean}
 */
function fallbackCopy(text) {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, 99999);
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  } catch (err) {
    logger.error('Fallback copy failed:', err);
    return false;
  }
}

// ========== 浏览器兼容性检测 ==========
/**
 * 检查浏览器兼容性
 * @returns {string[]}
 */
export function checkCompatibility() {
  const issues = [];
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    issues.push("getUserMedia");
  }
  if (!(window.RTCPeerConnection || window.webkitRTCPeerConnection)) {
    issues.push("RTCPeerConnection");
  }
  if (
    location.protocol !== "https:" &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1"
  ) {
    issues.push("https");
  }
  return issues;
}

// ========== URL 工具 ==========
/**
 * 从 URL hash 解析 token
 * @returns {string|null}
 */
export function getTokenFromUrl() {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  return hashParams.get("token") || hashParams.get("room");
}

/**
 * 构建分享链接
 * @param {string} token
 * @returns {string}
 */
export function buildShareLink(token) {
  const url = new URL(window.location.href);
  url.hash = `token=${token}`;
  url.search = "";
  return url.toString();
}

// ========== 音频解锁 ==========
/**
 * 解锁 iOS/Safari 自动播放
 */
export function unlockAudio() {
  try {
    // Play a silent Audio element to unlock autoplay for HTMLAudioElement
    const silent = new Audio();
    silent.play().catch(() => {});
    
    // Also unlock Web Audio API context
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.01);
    ctx.close().catch(() => {});
  } catch (err) {
    logger.debug('Audio unlock failed:', err);
  }
}

// ========== 错误处理 ==========
/**
 * 全局错误处理器初始化
 * @param {Function} onError
 */
export function initGlobalErrorHandler(onError) {
  window.addEventListener('error', (event) => {
    logger.error('Unhandled error:', event.error);
    if (onError) onError(event.error);
  });
  
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('Unhandled promise rejection:', event.reason);
    if (onError) onError(event.reason);
  });
}

export default {
  $,
  $$,
  clearDomCache,
  logger,
  generateToken,
  sanitizeToken,
  haptic,
  formatDuration,
  debounce,
  throttle,
  announce,
  copyToClipboard,
  checkCompatibility,
  getTokenFromUrl,
  buildShareLink,
  unlockAudio,
  initGlobalErrorHandler,
};
