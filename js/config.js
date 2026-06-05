/**
 * iSay 配置中心
 * 集中管理所有常量、阈值和配置项
 */

// ========== 网络配置 ==========
export const NETWORK = {
  MAX_PEERS: 8,
  MAX_RECONNECT_ATTEMPTS: 3,
  RECONNECT_BACKOFF: [2000, 4000, 8000],
  CALL_STREAM_TIMEOUT: 18000,
  HOST_RETRY_DELAYS: [0, 2500, 6500],
  MESH_CONNECT_DELAY: 900,
  MESH_SCAN_INTERVAL: 8000,
  ICE_RESTART_COOLDOWN: 10000,
  PENDING_CALLS_LIMIT: 4,
};

// ========== ICE 配置 ==========
export const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
  iceTransportPolicy: "all",
};

// ========== 音频配置 ==========
export const AUDIO = {
  CONSTRAINTS: {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: { ideal: 48000 },
      channelCount: { ideal: 1 },
      googEchoCancellation: true,
      googAutoGainControl: true,
      googNoiseSuppression: true,
      googHighpassFilter: true,
      googTypingNoiseDetection: true,
      mozAutoGainControl: true,
      mozNoiseSuppression: true,
    },
    video: false,
  },
  BITRATE: {
    LOW: 16000,
    MEDIUM: 32000,
    HIGH: 64000,
    CAP_THRESHOLD_4: 32000,
    CAP_THRESHOLD_6: 24000,
  },
  JITTER_BUFFER: {
    ULTRA_LOW: 10,
    GOOD: 20,
    MODERATE: 40,
    LOSSY: 60,
  },
  VISUALIZER: {
    FFT_SIZE: 256,
    SMOOTHING: 0.8,
    BAR_COUNT: 40,
    BAR_GAP: 2,
    SPEAKING_THRESHOLD: 0.05,
  },
};

// ========== QoS 阈值 ==========
export const QOS = {
  LOSS: {
    BAD: 10,
    WARN: 3,
    CRITICAL: 12,
    GOOD: 5,
  },
  JITTER: {
    BAD: 100,
    WARN: 50,
    GOOD: 15,
    MODERATE: 30,
    HIGH: 60,
  },
  RTT: {
    BAD: 0.5,
    WARN: 0.3,
  },
  LATENCY: {
    BAD: 400,
    WARN: 300,
    GOOD: 100,
    EXCELLENT: 150,
  },
  CONSEC_BAD_THRESHOLD: 2,
  STATS_INTERVAL: 2000,
  GLITCH_RATE_THRESHOLD: 0.03,
  GLITCH_COOLDOWN: 8000,
};

// ========== 连接状态检测超时 ==========
export const TIMEOUTS = {
  DISCONNECTED_ICE_RESTART: 5000,
  CONNECTING_ICE_RESTART: 15000,
  STREAM_RECOVER: [6000, 12000],
  CALL_RETRY_DELAY: 1500,
  SIGNALING_RECONNECT: [500, 1000, 2000],
  MESH_SCAN_THROTTLE: 4000,
  HOST_SCAN_INITIAL: 800,
  PING_TIMEOUT: 5000,
  TOAST_DEFAULT: 3000,
  TOAST_SHORT: 1500,
  TOAST_LONG: 8000,
  COPY_FEEDBACK: 2000,
  RESIZE_DEBOUNCE: 1500,
};

// ========== UI 配置 ==========
export const UI = {
  TOAST_MAX_WIDTH: 340,
  CANVAS_RESIZE_DEBOUNCE: 150,
  CHAT_HEIGHT: 140,
};

// ========== 词表配置 ==========
export const WORD_LISTS = {
  ADJECTIVES: [
    "brave", "calm", "dark", "eager", "fair", "glad", "happy", "jolly", "keen", "lively",
    "merry", "noble", "proud", "quick", "rapid", "sharp", "swift", "vivid", "warm", "wise",
    "azure", "coral", "frost", "golden", "ivory", "lunar", "maple", "ocean", "pearl", "solar",
    "amber", "blaze", "cedar", "delta", "ember", "flint", "grove", "hazel", "indigo", "jade",
  ],
  NOUNS: [
    "wolf", "bear", "fox", "hawk", "eagle", "lion", "tiger", "panda", "otter", "dove",
    "star", "moon", "sun", "wave", "wind", "rain", "snow", "fire", "leaf", "rock",
    "peak", "vale", "bay", "isle", "reef", "glen", "dune", "mist", "bolt", "crest",
    "fern", "kite", "lynx", "moth", "opus", "quill", "rune", "sage", "tide", "vibe",
  ],
};

// ========== Peer ID 格式 ==========
export const PEER_ID = {
  PREFIX: "isay",
  HOST_SUFFIX: "host",
  GUEST_PREFIX: "g",
  format: {
    host: (token) => `isay-${token}-host`,
    guest: (token, index) => `isay-${token}-g${index}`,
  },
  parse: (id) => {
    const match = id.match(/^isay-(.+)-(host|g(\d+))$/);
    if (!match) return null;
    return { token: match[1], role: match[2] === "host" ? "host" : "guest", index: match[3] ? parseInt(match[3]) : -1 };
  },
};

// ========== 浏览器检测 ==========
export const BROWSER = {
  isSafari: /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
  isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
};

// ========== 错误消息 ==========
export const ERROR_MESSAGES = {
  NotAllowedError: {
    title: "需要麦克风权限",
    message: "请点击地址栏的麦克风图标，允许访问后重试",
    userMessage: "Microphone blocked. Allow in browser settings, then reload.",
  },
  NotFoundError: {
    title: "未检测到麦克风",
    message: "请连接耳机或检查麦克风设备",
    userMessage: "No microphone detected. Connect a headset.",
  },
  NotReadableError: {
    title: "麦克风被占用",
    message: "请关闭 Zoom/Teams 等应用后重试",
    userMessage: "Microphone in use. Close Zoom/Teams and retry.",
  },
  TimeoutError: {
    title: "连接超时",
    message: "请确保对方已打开链接",
    userMessage: "Connection timed out. Make sure the other person has the link open.",
  },
  RoomFullError: {
    title: "房间已满",
    message: `最多支持 ${NETWORK.MAX_PEERS} 人同时通话`,
    userMessage: "Room is full.",
  },
};

// ========== 质量评级 ==========
export const QUALITY_LABELS = {
  1: "Terrible",
  2: "Poor",
  3: "Fair",
  4: "Good",
  5: "Excellent",
};

// ========== 连接类型映射 ==========
export const CONN_TYPE_MAP = {
  checking: { icon: "...", text: "Connecting" },
  p2p: { icon: "P", text: "Direct P2P" },
  relay: { icon: "R", text: "Relay (TURN)" },
  disconnected: { icon: "!", text: "Reconnecting" },
  failed: { icon: "X", text: "Failed" },
};

export default {
  NETWORK,
  ICE_CONFIG,
  AUDIO,
  QOS,
  TIMEOUTS,
  UI,
  WORD_LISTS,
  PEER_ID,
  BROWSER,
  ERROR_MESSAGES,
  QUALITY_LABELS,
  CONN_TYPE_MAP,
};
