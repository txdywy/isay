(() => {
  "use strict";

  // ========== State ==========
  let peer = null;
  let currentCall = null;
  let localStream = null;
  let isMuted = false;
  let callStartTime = null;
  let durationTimer = null;
  let audioCtx = null;
  let localAnalyser = null;
  let remoteAnalyser = null;
  let vizRAF = null;
  let statsInterval = null;
  let prevStats = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let currentToken = null;
  let currentRole = null;
  let iceRestarted = false;
  let wakeLock = null;
  let lastQualityScore = -1;

  const MAX_RECONNECT_ATTEMPTS = 3;
  const ICE_RECONNECT_WAIT = 4000;
  const RECONNECT_BACKOFF = [2000, 4000, 8000];

  // ========== Word list for auto-token ==========
  const ADJECTIVES = [
    "brave","calm","dark","eager","fair","glad","happy","jolly","keen","lively",
    "merry","noble","proud","quick","rapid","sharp","swift","vivid","warm","wise",
    "azure","coral","frost","golden","ivory","lunar","maple","ocean","pearl","solar",
    "amber","blaze","cedar","delta","ember","flint","grove","hazel","indigo","jade",
  ];
  const NOUNS = [
    "wolf","bear","fox","hawk","eagle","lion","tiger","panda","otter","dove",
    "star","moon","sun","wave","wind","rain","snow","fire","leaf","rock",
    "peak","vale","bay","isle","reef","glen","dune","mist","bolt","crest",
    "fern","kite","lynx","moth","opus","quill","rune","sage","tide","vibe",
  ];

  function generateToken() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = Math.floor(Math.random() * 100);
    return `${adj}-${noun}-${num}`;
  }

  // ========== Wake Lock ==========
  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (_) {}
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
  }

  // ========== Toast notifications ==========
  function showToast(message, duration = 3000) {
    let container = $("#toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ========== Screen reader announcer ==========
  function announce(text) {
    const el = $("#sr-announcer");
    if (el) el.textContent = text;
  }

  // ========== Browser compatibility check ==========
  function checkCompatibility() {
    const issues = [];
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      issues.push("getUserMedia");
    }
    if (!(window.RTCPeerConnection || window.webkitRTCPeerConnection)) {
      issues.push("RTCPeerConnection");
    }
    if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      issues.push("https");
    }
    return issues;
  }

  // --- Audio constraints ---
  const AUDIO_CONSTRAINTS = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1,
      googEchoCancellation: true,
      googAutoGainControl: true,
      googNoiseSuppression: true,
      googHighpassFilter: true,
      googTypingNoiseDetection: true,
    },
    video: false,
  };

  // --- ICE config ---
  const ICE_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
      {
        urls: [
          "turn:openrelay.metered.ca:80",
          "turn:openrelay.metered.ca:443",
          "turn:openrelay.metered.ca:443?transport=tcp",
        ],
        username: "openrelayproject",
        credential: "openrelayproject",
      },
      {
        urls: [
          "turns:openrelay.metered.ca:443",
          "turns:openrelay.metered.ca:443?transport=tcp",
        ],
        username: "openrelayproject",
        credential: "openrelayproject",
      },
    ],
    iceTransportPolicy: "all",
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 2,
  };

  // --- DOM ---
  const $ = (sel) => document.querySelector(sel);
  const screens = {
    landing: $("#screen-landing"),
    waiting: $("#screen-waiting"),
    call: $("#screen-call"),
    disconnected: $("#screen-disconnected"),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
  }

  // --- Media ---
  async function getLocalStream() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
    return localStream;
  }

  function stopLocalStream() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
  }

  // --- SDP optimization ---
  function optimizeSDP(sdp) {
    const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!opusMatch) return sdp;
    const opusPT = opusMatch[1];
    const fmtpLine = `a=fmtp:${opusPT} minptime=10;useinbandfec=1;maxaveragebitrate=32000;stereo=0;cbr=0;sprop-stereo=0;maxplaybackrate=16000`;
    const lines = sdp.split("\r\n");
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(`a=fmtp:${opusPT}`)) {
        lines[i] = fmtpLine;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(`a=rtpmap:${opusPT}`)) {
          lines.splice(i + 1, 0, fmtpLine);
          break;
        }
      }
    }
    return lines.join("\r\n");
  }

  function applySDPOptimization(call) {
    const pc = call.peerConnection;
    if (!pc) return;
    const origCreateOffer = pc.createOffer.bind(pc);
    pc.createOffer = async function (...args) {
      const offer = await origCreateOffer(...args);
      offer.sdp = optimizeSDP(offer.sdp);
      return offer;
    };
    const origCreateAnswer = pc.createAnswer.bind(pc);
    pc.createAnswer = async function (...args) {
      const answer = await origCreateAnswer(...args);
      answer.sdp = optimizeSDP(answer.sdp);
      return answer;
    };
    const origSetRemote = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = async function (desc) {
      if (desc && desc.sdp) desc.sdp = optimizeSDP(desc.sdp);
      return origSetRemote(desc);
    };
  }

  // --- Adaptive bitrate ---
  async function adaptAudioBitrate(pc, loss, jitter, rtt) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) {
        params.encodings = [{}];
      }
      let targetBitrate;
      if (loss > 10 || jitter > 100 || rtt > 0.5) {
        targetBitrate = 12000; // Poor: narrowband
      } else if (loss > 3 || jitter > 50 || rtt > 0.3) {
        targetBitrate = 24000; // Moderate: super-wideband
      } else {
        targetBitrate = 48000; // Good: fullband
      }
      params.encodings[0].maxBitrate = targetBitrate;
      params.encodings[0].priority = "high";
      await sender.setParameters(params);
    } catch (_) {}
  }

  // --- Jitter buffer tuning ---
  function configureJitterBuffer(pc, jitter) {
    try {
      const receivers = pc.getReceivers();
      receivers.forEach((receiver) => {
        if (receiver.track.kind === "audio" && "jitterBufferTarget" in receiver) {
          // Adaptive: more jitter = bigger buffer
          if (jitter < 20) receiver.jitterBufferTarget = 20;
          else if (jitter < 50) receiver.jitterBufferTarget = 40;
          else receiver.jitterBufferTarget = 80;
        }
      });
    } catch (_) {}
  }

  // --- Network migration detection ---
  function setupNetworkMigration(pc) {
    if (!navigator.connection) return;
    let lastType = navigator.connection.effectiveType;
    navigator.connection.addEventListener("change", () => {
      const newType = navigator.connection.effectiveType;
      if (newType !== lastType) {
        lastType = newType;
        showToast(`Network changed to ${newType}. Adjusting...`);
        try { pc.restartIce(); } catch (_) {}
      }
    });
  }

  // --- Duration ---
  function startDurationTimer() {
    callStartTime = Date.now();
    durationTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const ss = String(elapsed % 60).padStart(2, "0");
      $("#call-duration").textContent = `${mm}:${ss}`;
    }, 1000);
  }

  function stopDurationTimer() {
    clearInterval(durationTimer);
    durationTimer = null;
  }

  // ========== Phase indicator ==========
  function setPhase(name) {
    const order = ["signaling", "ice", "connected"];
    const idx = order.indexOf(name);
    const label = { signaling: "Establishing signaling...", ice: "Negotiating connection...", connected: "Connected" };

    document.querySelectorAll(".phase-step").forEach((el) => {
      const p = el.dataset.phase;
      const pi = order.indexOf(p);
      el.classList.toggle("done", pi < idx);
      el.classList.toggle("active", pi === idx);
    });
    document.querySelectorAll(".phase-line").forEach((line, i) => {
      line.classList.toggle("done", i < idx);
      line.classList.toggle("active", i === idx);
    });
    const lbl = $("#phase-label");
    if (lbl) lbl.textContent = label[name] || "";
    announce(label[name] || "");
  }

  // ========== QR Code ==========
  function generateQR(text, canvas, size) {
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    if (!generateQR._loaded) {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/qrcode@latest/build/qrcode.min.js";
      script.onload = () => {
        generateQR._loaded = true;
        generateQR(text, canvas, size);
      };
      script.onerror = () => {
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = "#888";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("QR unavailable", size / 2, size / 2);
      };
      document.head.appendChild(script);
      return;
    }

    try {
      QRCode.toCanvas(canvas, text, {
        width: size,
        margin: 2,
        color: { dark: "4f9cf7", light: "1a1a1a" },
        errorCorrectionLevel: "M",
      }, (err) => {
        if (err) {
          ctx.fillStyle = "#1a1a1a";
          ctx.fillRect(0, 0, size, size);
          ctx.fillStyle = "#888";
          ctx.font = "12px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("QR error", size / 2, size / 2);
        }
      });
    } catch (_) {
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("QR error", size / 2, size / 2);
    }
  }

  // ========== Speaking detection ==========
  function getRMS(analyser) {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  function updateSpeakingIndicators() {
    const localRMS = getRMS(localAnalyser);
    const remoteRMS = getRMS(remoteAnalyser);

    const localLabel = $("#label-local");
    const remoteLabel = $("#label-remote");
    if (localLabel) localLabel.classList.toggle("speaking", localRMS > 0.05 && !isMuted);
    if (remoteLabel) remoteLabel.classList.toggle("speaking", remoteRMS > 0.05);
  }

  // ========== Audio Visualizer ==========
  function initAudioViz(remoteStream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    } catch (_) { return; }

    const localSrc = audioCtx.createMediaStreamSource(localStream);
    localAnalyser = audioCtx.createAnalyser();
    localAnalyser.fftSize = 256;
    localAnalyser.smoothingTimeConstant = 0.8;
    localSrc.connect(localAnalyser);

    if (remoteStream) {
      const remoteSrc = audioCtx.createMediaStreamSource(remoteStream);
      remoteAnalyser = audioCtx.createAnalyser();
      remoteAnalyser.fftSize = 256;
      remoteAnalyser.smoothingTimeConstant = 0.8;
      remoteSrc.connect(remoteAnalyser);
    }

    drawVisualizer();
  }

  function drawVisualizer() {
    const canvas = $("#visualizer");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    const bufLen = localAnalyser ? localAnalyser.frequencyBinCount : 128;
    const localData = new Uint8Array(bufLen);
    const remoteData = new Uint8Array(bufLen);

    function draw() {
      vizRAF = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, W, H);

      if (localAnalyser) localAnalyser.getByteFrequencyData(localData);
      if (remoteAnalyser) remoteAnalyser.getByteFrequencyData(remoteData);

      const barCount = 40;
      const barW = (W - (barCount - 1) * 2) / barCount;
      const step = Math.floor(bufLen / barCount);

      drawBars(ctx, remoteData, barCount, barW, step, W, H, "#22c55e", 0.7, true);
      drawBars(ctx, localData, barCount, barW, step, W, H, "#4f9cf7", 0.8, false);
      updateSpeakingIndicators();
    }

    draw();
  }

  function drawBars(ctx, data, count, barW, step, W, H, color, alpha, fromBottom) {
    const halfH = H / 2;
    const centerY = fromBottom ? H : 0;
    for (let i = 0; i < count; i++) {
      const val = data[i * step] / 255;
      const barH = Math.max(2, val * halfH * 0.9);
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha * (0.3 + val * 0.7);
      const x = i * (barW + 2);
      const radius = Math.min(barW / 2, 3);
      if (fromBottom) roundRect(ctx, x, centerY - barH, barW, barH, radius);
      else roundRect(ctx, x, centerY, barW, barH, radius);
    }
    ctx.globalAlpha = 1;
  }

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

  function stopAudioViz() {
    if (vizRAF) cancelAnimationFrame(vizRAF);
    vizRAF = null;
    localAnalyser = null;
    remoteAnalyser = null;
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  }

  // ========== Connection quality monitoring ==========
  function setConnType(type) {
    const badge = $("#conn-type-badge");
    const icon = $("#conn-icon");
    const text = $("#conn-type-text");
    badge.className = "conn-badge " + type;
    const map = {
      checking: { icon: "...", text: "Connecting" },
      p2p: { icon: "P", text: "Direct P2P" },
      relay: { icon: "R", text: "Relay (TURN)" },
      disconnected: { icon: "!", text: "Reconnecting" },
      failed: { icon: "X", text: "Failed" },
    };
    const m = map[type] || map.checking;
    icon.textContent = m.icon;
    text.textContent = m.text;
  }

  function setQuality(level, label) {
    const el = $("#quality-segments");
    el.setAttribute("data-quality", level);
    $("#quality-label").textContent = label;

    // Toast on quality transitions
    if (lastQualityScore >= 4 && level <= 2 && level > 0) {
      showToast("Connection quality degraded. Audio may be interrupted.");
    } else if (lastQualityScore <= 2 && level >= 4) {
      showToast("Connection quality restored.");
    }
    if (level > 0) lastQualityScore = level;
  }

  function updateMetrics(latency, jitter, loss) {
    const lv = $("#metric-latency");
    const jv = $("#metric-jitter");
    const lo = $("#metric-loss");

    lv.textContent = latency >= 0 ? Math.round(latency) : "--";
    jv.textContent = jitter >= 0 ? Math.round(jitter) : "--";
    lo.textContent = loss >= 0 ? loss.toFixed(1) + "%" : "--";

    lv.style.color = latency < 0 ? "" : latency < 100 ? "var(--success)" : latency < 300 ? "var(--warning)" : "var(--danger)";
    jv.style.color = jitter < 0 ? "" : jitter < 30 ? "var(--success)" : jitter < 80 ? "var(--warning)" : "var(--danger)";
    lo.style.color = loss < 0 ? "" : loss < 2 ? "var(--success)" : loss < 5 ? "var(--warning)" : "var(--danger)";

    if (latency >= 0) {
      let score = 5;
      if (latency > 150) score--;
      if (latency > 300) score--;
      if (jitter > 50) score--;
      if (loss > 3) score--;
      if (loss > 8) score--;
      score = Math.max(1, score);
      const labels = { 1: "Terrible", 2: "Poor", 3: "Fair", 4: "Good", 5: "Excellent" };
      setQuality(score, labels[score]);
    }
  }

  function startStatsMonitor(pc) {
    prevStats = null;
    let consecBad = 0;
    statsInterval = setInterval(() => {
      if (!pc || pc.connectionState === "closed") { stopStatsMonitor(); return; }
      pc.getStats().then((stats) => {
        let isRelay = false;
        let currentPair = null;
        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded") currentPair = report;
          if (report.type === "local-candidate" && report.candidateType === "relay") isRelay = true;
        });
        if (currentPair) {
          const latency = currentPair.currentRoundTripTime ? currentPair.currentRoundTripTime * 1000 : -1;
          let loss = -1, jitter = -1;
          stats.forEach((report) => {
            if (report.type === "inbound-rtp" && report.kind === "audio") {
              if (prevStats && prevStats[report.id]) {
                const prev = prevStats[report.id];
                const dRecv = report.packetsReceived - prev.packetsReceived;
                const dLost = (report.packetsLost || 0) - (prev.packetsLost || 0);
                const total = dRecv + dLost;
                if (total > 0) loss = (dLost / total) * 100;
              } else {
                const total = report.packetsReceived + (report.packetsLost || 0);
                if (total > 0) loss = ((report.packetsLost || 0) / total) * 100;
              }
              if (report.jitter !== undefined) jitter = report.jitter * 1000;
              if (!prevStats) prevStats = {};
              prevStats[report.id] = { packetsReceived: report.packetsReceived, packetsLost: report.packetsLost || 0 };
            }
          });
          updateMetrics(latency, jitter, loss);
          setConnType(isRelay ? "relay" : "p2p");

          // Adaptive bitrate + jitter buffer tuning
          const rtt = currentPair.currentRoundTripTime || 0;
          adaptAudioBitrate(pc, loss, jitter, rtt);
          configureJitterBuffer(pc, jitter);
          if (loss > 15 || latency > 500) {
            consecBad++;
            if (consecBad >= 3 && currentCall) { attemptICERestart(); consecBad = 0; }
          } else {
            consecBad = 0;
          }
        }
      }).catch(() => {});
    }, 2000);
  }

  function stopStatsMonitor() {
    clearInterval(statsInterval);
    statsInterval = null;
    prevStats = null;
    lastQualityScore = -1;
  }

  // ========== ICE restart & reconnection ==========
  function attemptICERestart() {
    if (!currentCall || !currentCall.peerConnection) return;
    const pc = currentCall.peerConnection;
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      try { pc.restartIce(); } catch (_) {}
    }
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      endCall("Connection lost. Max reconnection attempts reached.");
      return;
    }
    const delay = RECONNECT_BACKOFF[Math.min(reconnectAttempts, RECONNECT_BACKOFF.length - 1)];
    setConnType("disconnected");
    updateMetrics(-1, -1, -1);
    setQuality(0, "Reconnecting...");
    const lbl = $("#phase-label");
    if (lbl) lbl.textContent = `Reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`;
    announce("Connection lost. Reconnecting.");

    clearReconnectTimer();
    reconnectTimer = setTimeout(async () => {
      reconnectAttempts++;
      if (!currentToken) { endCall("Connection lost."); return; }
      if (currentCall) {
        currentCall.close();
        if (currentCall._remoteAudio) { currentCall._remoteAudio.pause(); currentCall._remoteAudio.srcObject = null; }
        currentCall = null;
      }
      stopAudioViz();
      stopStatsMonitor();
      destroyPeer();
      showScreen("waiting");
      setPhase("signaling");
      try {
        const result = await connectPeer(currentToken);
        peer = result.peer;
      } catch (err) {
        endCall("Reconnection failed: " + (err.message || "unknown error"));
      }
    }, delay);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  // ========== Peer connection monitoring ==========
  function monitorPeerConnection(call) {
    const pc = call.peerConnection;
    if (!pc) return;
    iceRestarted = false;
    setupNetworkMigration(pc);

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      switch (state) {
        case "checking": setConnType("checking"); break;
        case "connected":
        case "completed":
          reconnectAttempts = 0;
          iceRestarted = false;
          startStatsMonitor(pc);
          announce("Connected. Call active.");
          break;
        case "disconnected":
          if (!iceRestarted) {
            iceRestarted = true;
            setConnType("disconnected");
            setTimeout(() => { if (pc.iceConnectionState === "disconnected") attemptICERestart(); }, ICE_RECONNECT_WAIT);
          } else { scheduleReconnect(); }
          break;
        case "failed": scheduleReconnect(); break;
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") scheduleReconnect();
    };
  }

  // --- Call handling ---
  function handleCall(call) {
    currentCall = call;
    clearCallTimeout();
    setPhase("connected");
    applySDPOptimization(call);

    call.on("stream", (remoteStream) => {
      const audio = new Audio();
      audio.srcObject = remoteStream;
      audio.autoplay = true;
      currentCall._remoteAudio = audio;
      initAudioViz(remoteStream);
    });
    call.on("close", () => endCall("Peer disconnected"));
    call.on("error", (err) => endCall("Call error: " + err.type));

    monitorPeerConnection(call);
    startDurationTimer();
    requestWakeLock();
    setTimeout(() => showScreen("call"), 400);
  }

  // --- Call timeout ---
  let callTimeoutId = null;
  function setCallTimeout() { clearCallTimeout(); callTimeoutId = setTimeout(() => endCall("No answer. The other user may have left."), 15000); }
  function clearCallTimeout() { if (callTimeoutId) { clearTimeout(callTimeoutId); callTimeoutId = null; } }

  function endCall(reason) {
    clearCallTimeout();
    clearReconnectTimer();
    stopDurationTimer();
    stopAudioViz();
    stopStatsMonitor();
    releaseWakeLock();
    reconnectAttempts = 0;
    iceRestarted = false;
    if (currentCall) {
      currentCall.close();
      if (currentCall._remoteAudio) { currentCall._remoteAudio.pause(); currentCall._remoteAudio.srcObject = null; }
      currentCall = null;
    }
    stopLocalStream();
    destroyPeer();
    $("#disconnect-reason").textContent = reason || "The call has ended";
    announce("Call ended. " + (reason || ""));
    showScreen("disconnected");
  }

  function destroyPeer() { if (peer) { peer.destroy(); peer = null; } }

  // --- PeerJS connection ---
  async function connectPeer(token) {
    const hostId = `isay-${token}-host`;
    currentToken = token;

    return new Promise(async (resolve, reject) => {
      try {
        await getLocalStream();
      } catch (err) {
        const name = err.name;
        if (name === "NotAllowedError") reject(new Error("Microphone blocked. Open browser settings, allow microphone for this site, then reload."));
        else if (name === "NotFoundError") reject(new Error("No microphone detected. Connect a microphone or headset."));
        else if (name === "NotReadableError") reject(new Error("Microphone in use. Close other apps (Zoom, Teams) and try again."));
        else reject(new Error("Microphone access denied. Please allow permission."));
        return;
      }

      setPhase("signaling");
      let isHost = false;

      const p = new Peer(hostId, { debug: 0, config: ICE_CONFIG });

      p.on("open", (id) => {
        isHost = true;
        currentRole = "host";
        setPhase("ice");
        p.on("call", (call) => { call.answer(localStream); handleCall(call); });
        resolve({ peer: p, role: "host" });
      });

      p.on("error", (err) => {
        if (err.type === "unavailable-id" && !isHost) {
          p.destroy();
          const guestId = `isay-${token}-guest-${Math.random().toString(36).slice(2, 8)}`;
          const guestPeer = new Peer(guestId, { debug: 0, config: ICE_CONFIG });

          guestPeer.on("open", () => {
            currentRole = "guest";
            setPhase("ice");
            const call = guestPeer.call(hostId, localStream);
            if (call) { setCallTimeout(); handleCall(call); }
            else { reject(new Error("Failed to initiate call")); return; }
            resolve({ peer: guestPeer, role: "guest" });
          });
          guestPeer.on("error", (guestErr) => reject(guestErr));
        } else if (!isHost) { reject(err); }
      });

      setTimeout(() => { if (!isHost && !peer) { p.destroy(); reject(new Error("Connection timed out. Make sure the other person has the link open.")); } }, 10000);
    });
  }

  // --- Share link ---
  function buildShareLink(token) {
    const url = new URL(window.location.href);
    url.hash = `token=${token}`;
    url.search = "";
    return url.toString();
  }

  function showShareLink(token) {
    const link = buildShareLink(token);
    $("#share-link").value = link;
    // Generate QR code
    const qrCanvas = $("#qr-canvas");
    if (qrCanvas) generateQR(link, qrCanvas, 160);
  }

  function copyShareLink() {
    const link = $("#share-link").value;
    const hint = $("#copy-hint");
    const btn = $("#btn-copy-link");

    if (navigator.share) {
      navigator.share({ title: "Join my voice chat", text: `Join my iSay room`, url: link }).catch(() => {});
      return;
    }

    navigator.clipboard.writeText(link).then(() => {
      btn.classList.add("copied");
      hint.textContent = "Copied!";
      haptic(20);
      setTimeout(() => { btn.classList.remove("copied"); hint.textContent = ""; }, 2000);
    }).catch(() => {
      $("#share-link").select();
      hint.textContent = "Press Ctrl+C to copy";
    });
  }

  // --- Haptic feedback ---
  function haptic(pattern) {
    if ("vibrate" in navigator) { try { navigator.vibrate(pattern); } catch (_) {} }
  }

  // --- UI Events ---
  async function joinRoom(token) {
    if (typeof token !== "string") token = $("#token-input").value;
    token = token.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
    if (!token) { $("#token-input").focus(); return; }

    showShareLink(token);
    setPhase("signaling");
    showScreen("waiting");

    try {
      const result = await connectPeer(token);
      peer = result.peer;
      if (result.role === "host") $("#call-status-text").textContent = "Connected";
    } catch (err) {
      destroyPeer();
      stopLocalStream();
      $("#disconnect-reason").textContent = err.message || "Connection failed";
      showScreen("disconnected");
    }
  }

  function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((track) => { track.enabled = !isMuted; });
    $("#btn-mute").classList.toggle("muted", isMuted);
    $("#icon-mic-on").style.display = isMuted ? "none" : "";
    $("#icon-mic-off").style.display = isMuted ? "" : "none";
    $("#mute-label").textContent = isMuted ? "Unmute" : "Mute";
    $("#btn-mute").setAttribute("aria-pressed", isMuted);
    haptic(isMuted ? 30 : [20, 10, 20]);
    announce(isMuted ? "Microphone muted" : "Microphone unmuted");
  }

  function restart() {
    destroyPeer();
    stopLocalStream();
    stopAudioViz();
    stopStatsMonitor();
    clearReconnectTimer();
    releaseWakeLock();
    reconnectAttempts = 0;
    currentToken = null;
    currentRole = null;
    isMuted = false;
    $("#token-input").value = generateToken();
    $("#btn-mute").classList.remove("muted");
    $("#icon-mic-on").style.display = "";
    $("#icon-mic-off").style.display = "none";
    $("#mute-label").textContent = "Mute";
    showScreen("landing");
  }

  // ========== Background / Foreground ==========
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && currentCall) {
      await requestWakeLock();
      // Resume AudioContext if suspended (iOS phone call interruption)
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      // Check ICE state on return
      const pc = currentCall.peerConnection;
      if (pc && (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed")) {
        attemptICERestart();
        showToast("Reconnecting after background...");
      }
    }
  });

  // ========== Event binding ==========
  $("#btn-join").addEventListener("click", () => joinRoom());
  $("#token-input").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  $("#btn-copy-link").addEventListener("click", copyShareLink);
  $("#btn-cancel-wait").addEventListener("click", () => { destroyPeer(); stopLocalStream(); showScreen("landing"); });
  $("#btn-mute").addEventListener("click", toggleMute);
  $("#btn-hangup").addEventListener("click", () => endCall("You ended the call"));
  $("#btn-restart").addEventListener("click", restart);

  // Space key to toggle mute during call
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && currentCall && !e.repeat) {
      e.preventDefault();
      toggleMute();
    }
  });

  // ========== Init ==========
  // Compatibility check
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
    showToast("HTTPS required for microphone. Open via https:// or localhost.", 8000);
  }

  // Auto-generate token
  const tokenInput = $("#token-input");
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const urlToken = hashParams.get("token") || hashParams.get("room");
  if (urlToken) {
    joinRoom(urlToken);
  } else {
    tokenInput.value = generateToken();
  }
})();
