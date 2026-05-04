(() => {
  "use strict";

  // ========== State ==========
  let peer = null;                     // Our PeerJS instance
  let localStream = null;
  let isMuted = false;
  let callStartTime = null;
  let durationTimer = null;
  let audioCtx = null;
  let localAnalyser = null;
  let vizRAF = null;
  let statsInterval = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let currentToken = null;
  let currentRole = null;              // "host" or "guest"
  let currentPeerId = null;
  let wakeLock = null;
  let lastQualityScore = -1;
  let currentAudioOutput = "default";
  let speakerOn = true;
  let networkMigrationInitialized = false;
  let meshScanTimer = null;
  let hostScanTimer = null;

  // Mesh: track all active peer connections
  const peers = new Map(); // peerId -> { call, remoteAudio, analyser }
  const pendingCalls = new Map(); // peerId -> { call, timer, attempts }
  const qosByConnection = new WeakMap();
  const MAX_PEERS = 8;

  const MAX_RECONNECT_ATTEMPTS = 3;
  const RECONNECT_BACKOFF = [2000, 4000, 8000];
  const CALL_STREAM_TIMEOUT = 18000;
  const HOST_RETRY_DELAYS = [0, 2500, 6500];
  const MESH_CONNECT_DELAY = 900;
  const MESH_SCAN_INTERVAL = 8000;

  // ========== Word list ==========
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

  // ========== Toast ==========
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

  // ========== Screen reader ==========
  function announce(text) {
    const el = $("#sr-announcer");
    if (el) el.textContent = text;
  }

  // ========== Browser compatibility ==========
  function checkCompatibility() {
    const issues = [];
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) issues.push("getUserMedia");
    if (!(window.RTCPeerConnection || window.webkitRTCPeerConnection)) issues.push("RTCPeerConnection");
    if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") issues.push("https");
    return issues;
  }

  // --- Safari detection ---
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // --- Audio constraints (optimized for low latency voice) ---
  const AUDIO_CONSTRAINTS = {
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
  };

  // --- ICE config (optimized for 5G + WiFi + restrictive NAT) ---
  const ICE_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
      { urls: "stun:stun.ekiga.net:3478" },
      { urls: "stun:stun.ideasip.com:3478" },
      {
        urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"],
        username: "peerjs",
        credential: "peerjsp",
      },
    ],
    iceTransportPolicy: "all",
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 4,
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

  // --- iOS/Safari autoplay unlock ---
  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    // Play a silent Audio element to unlock autoplay for HTMLAudioElement
    const silent = new Audio();
    silent.play().catch(() => {});
    // Also unlock Web Audio API context
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.01);
      ctx.close().catch(() => {});
    } catch (_) {}
  }

  // Global tap-to-resume: Safari may block autoplay until user interacts.
  // Any click/touch on the page retries playing all remote audios.
  function tryResumeAllAudio() {
    for (const [, info] of peers) {
      if (info.remoteAudio && info.remoteAudio.paused) {
        info.remoteAudio.play().catch(() => {});
      }
    }
  }
  document.addEventListener("click", tryResumeAllAudio);
  document.addEventListener("touchstart", tryResumeAllAudio);

  // --- Media ---
  async function getLocalStream() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
    localStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        showToast("Microphone disconnected.");
        if (peers.size > 0) endCall("Microphone disconnected.");
      };
    });
    return localStream;
  }

  function stopLocalStream() {
    if (localStream) {
      localStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      localStream = null;
    }
  }

  // --- SDP optimization (low latency, high quality voice) ---
  // Safari is strict about opus fmtp params: keep it conservative there.
  function optimizeSDP(sdp) {
    const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!opusMatch) return sdp;
    const opusPT = opusMatch[1];
    let fmtpLine;
    if (isSafari) {
      // Safari/iOS: minimal safe opus params
      fmtpLine = `a=fmtp:${opusPT} useinbandfec=1;maxaveragebitrate=48000;stereo=0;maxplaybackrate=48000`;
    } else {
      // Chrome/Firefox/Edge: full low-latency tuning
      fmtpLine = `a=fmtp:${opusPT} useinbandfec=1;maxaveragebitrate=48000;stereo=0;sprop-stereo=0;usedtx=1;cbr=0;maxplaybackrate=48000;sprop-maxcapturerate=48000`;
    }
    const lines = sdp.split("\r\n");
    let replaced = false;
    let lastOpusIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(`a=rtpmap:${opusPT}`) || lines[i].startsWith(`a=fmtp:${opusPT}`)) {
        lastOpusIdx = i;
      }
      if (lines[i].startsWith(`a=fmtp:${opusPT}`)) {
        lines[i] = fmtpLine;
        replaced = true;
      }
    }
    if (!replaced && lastOpusIdx >= 0) {
      lines.splice(lastOpusIdx + 1, 0, fmtpLine);
    }
    // ptime/maxptime: Safari ignores or rejects these; skip on Safari
    if (!isSafari) {
      const hasPtime = lines.some((l) => l === "a=ptime:20");
      const hasMaxptime = lines.some((l) => l === "a=maxptime:60");
      if (!hasPtime && lastOpusIdx >= 0) lines.splice(lastOpusIdx + 1, 0, "a=ptime:20");
      if (!hasMaxptime && lastOpusIdx >= 0) lines.splice(lastOpusIdx + 1, 0, "a=maxptime:60");
    }
    return lines.join("\r\n");
  }

  function applySDPOptimization(call) {
    const tryPatch = () => {
      const pc = call.peerConnection;
      if (!pc) {
        // PeerJS may create peerConnection asynchronously; retry next frame
        requestAnimationFrame(tryPatch);
        return;
      }
      if (pc._isayPatched) return;
      pc._isayPatched = true;
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
    };
    tryPatch();
  }

  // --- Adaptive bitrate ---
  async function adaptAudioBitrate(pc, loss, jitter, rtt) {
    const qos = getQoSState(pc);
    if (!qos.bitrateAppliedOnce) { qos.bitrateAppliedOnce = true; return; }
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      let targetBitrate;
      if (loss > 10 || jitter > 100 || rtt > 0.5) {
        targetBitrate = 16000;
      } else if (loss > 3 || jitter > 50 || rtt > 0.3) {
        targetBitrate = 32000;
      } else {
        targetBitrate = 64000; // Higher ceiling for good networks
      }
      // In mesh, cap send bitrate as peer count grows to protect uplink
      const peerCount = peers.size + 1;
      if (peerCount > 4) targetBitrate = Math.min(targetBitrate, 32000);
      if (peerCount > 6) targetBitrate = Math.min(targetBitrate, 24000);
      params.encodings[0].maxBitrate = targetBitrate;
      params.encodings[0].priority = "high";
      await sender.setParameters(params);
    } catch (_) {}
  }

  // --- Jitter buffer (aggressive low-latency for WiFi) ---
  function configureJitterBuffer(pc, jitter) {
    if (jitter < 0) return;
    try {
      pc.getReceivers().forEach((receiver) => {
        if (receiver.track.kind === "audio" && "jitterBufferTarget" in receiver) {
          if (jitter < 15) receiver.jitterBufferTarget = 10;      // LAN/WiFi: ultra-low
          else if (jitter < 30) receiver.jitterBufferTarget = 20;  // Good internet
          else if (jitter < 60) receiver.jitterBufferTarget = 40;  // Moderate
          else receiver.jitterBufferTarget = 60;                    // Lossy
        }
      });
    } catch (_) {}
  }

  // --- Network migration ---
  function setupNetworkMigration() {
    if (!navigator.connection || networkMigrationInitialized) return;
    networkMigrationInitialized = true;
    let lastType = navigator.connection.effectiveType;
    navigator.connection.addEventListener("change", () => {
      const newType = navigator.connection.effectiveType;
      if (newType !== lastType) {
        lastType = newType;
        showToast(`Network: ${newType}. Adjusting...`);
        for (const [, info] of peers) {
          attemptICERestart(info.call?.peerConnection);
        }
      }
    });
  }

  // ========== Audio session & routing ==========
  function configureAudioSession() {
    if ("audioSession" in navigator) {
      try {
        navigator.audioSession.type = speakerOn ? "play-and-record" : "voice-chat";
      } catch (_) {}
    }
  }

  async function toggleSpeaker() {
    speakerOn = !speakerOn;
    const btn = $("#btn-speaker");
    const iconOn = $("#icon-speaker");
    const iconOff = $("#icon-earpiece");
    const label = $("#speaker-label");
    if (btn) btn.classList.toggle("speaker-off", !speakerOn);
    if (iconOn) iconOn.style.display = speakerOn ? "" : "none";
    if (iconOff) iconOff.style.display = speakerOn ? "none" : "";
    if (label) label.textContent = speakerOn ? "Speaker" : "Earpiece";
    haptic(speakerOn ? [20, 10, 20] : 30);

    // iOS: use audioSession API
    configureAudioSession();

    // Adjust remote audio volumes to reduce echo in speakerphone mode
    for (const [, info] of peers) {
      if (info.remoteAudio) info.remoteAudio.volume = speakerOn ? 0.85 : 1.0;
    }

    // Desktop/Android: use setSinkId if available
    if ("setSinkId" in Audio.prototype) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === "audiooutput");
        let targetId = "default";
        if (!speakerOn) {
          const comm = outputs.find(d => /earpiece|communication/i.test(d.label));
          if (comm) targetId = comm.deviceId;
        } else {
          const speaker = outputs.find(d => /speaker/i.test(d.label) && !/earpiece/i.test(d.label));
          if (speaker) targetId = speaker.deviceId;
        }
        currentAudioOutput = targetId;
        for (const [, info] of peers) {
          if (info.remoteAudio && info.remoteAudio.setSinkId) {
            await info.remoteAudio.setSinkId(targetId);
          }
        }
      } catch (e) {
        showToast("Audio routing not available on this device.");
      }
    } else {
      showToast(speakerOn ? "Speaker mode" : "Earpiece mode", 1500);
    }
  }

  // ========== Peer count UI ==========
  function updatePeerCount() {
    const count = peers.size + 1; // +1 for self
    const el = $("#peer-count");
    if (el) el.textContent = count > 1 ? `${count} people` : "Waiting...";
    const statusEl = $("#call-status-text");
    if (statusEl && count > 1) statusEl.textContent = count > 2 ? `Group Call (${count})` : "Connected";
  }

  // ========== Mesh peer management ==========
  function addPeer(peerId, call, stream) {
    clearPendingCall(peerId, false);

    if (peers.has(peerId)) {
      try { call.close(); } catch (_) {}
      return;
    }

    if (peers.size >= MAX_PEERS) {
      call.close();
      showToast("Room is full (max 8 people).");
      return;
    }

    const remoteAudio = new Audio();
    remoteAudio.srcObject = stream;
    remoteAudio.autoplay = true;
    remoteAudio.playsInline = true;
    remoteAudio.setAttribute("playsinline", "");
    remoteAudio.volume = speakerOn ? 0.85 : 1.0; // Reduce echo in speakerphone mode
    // Safari requires audio element to be in the DOM tree to play
    if (isSafari) {
      remoteAudio.style.position = "absolute";
      remoteAudio.style.opacity = "0";
      remoteAudio.style.pointerEvents = "none";
      remoteAudio.style.width = "1px";
      remoteAudio.style.height = "1px";
      document.body.appendChild(remoteAudio);
    }
    const doPlay = () => {
      remoteAudio.play().then(() => {
        console.debug("[iSay] remoteAudio playing:", peerId);
      }).catch((err) => {
        console.warn("[iSay] remoteAudio play blocked:", peerId, err.name);
      });
    };
    // Safari needs loadedmetadata before play() will succeed reliably
    if (remoteAudio.readyState >= 1) {
      doPlay();
    } else {
      remoteAudio.addEventListener("loadedmetadata", doPlay, { once: true });
      // Fallback: if loadedmetadata never fires, try anyway after a short delay
      setTimeout(doPlay, 300);
    }
    if (currentAudioOutput !== "default" && remoteAudio.setSinkId) {
      remoteAudio.setSinkId(currentAudioOutput).catch(() => {});
    }

    let analyser = null;
    if (audioCtx) {
      try {
        const src = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        src.connect(analyser);
        // iOS Safari/ChromeWKWebView: HTMLAudioElement often fails to play WebRTC stream.
        // Route remote audio through AudioContext.destination as reliable fallback.
        src.connect(audioCtx.destination);
      } catch (e) {
        console.warn("[iSay] WebAudio routing failed:", e);
      }
    }

    peers.set(peerId, { call, remoteAudio, analyser });

    call.on("close", () => removePeer(peerId, false));
    call.on("error", () => removePeer(peerId));

    monitorSinglePeerConnection(call.peerConnection);
    updatePeerCount();
    if (peers.size === 1) {
      // First peer connected - show call screen
      clearMeshScanTimer();
      setPhase("connected");
      startDurationTimer();
      requestWakeLock();
      showScreen("call");
      configureAudioSession();
    }
  }

  function removePeer(peerId, closeCall = true) {
    const info = peers.get(peerId);
    if (!info) return;
    peers.delete(peerId);
    if (closeCall) {
      try { info.call.close(); } catch (_) {}
    }
    if (info.remoteAudio) {
      info.remoteAudio.pause();
      info.remoteAudio.srcObject = null;
      if (isSafari && info.remoteAudio.parentNode) {
        info.remoteAudio.parentNode.removeChild(info.remoteAudio);
      }
    }
    updatePeerCount();
    if (peers.size === 0 && currentToken) {
      endCall("All peers disconnected.");
    }
  }

  function closeAllPeers() {
    clearAllPendingCalls();
    for (const [id, info] of peers) {
      try { info.call.close(); } catch (_) {}
      if (info.remoteAudio) {
        info.remoteAudio.pause();
        info.remoteAudio.srcObject = null;
        if (isSafari && info.remoteAudio.parentNode) {
          info.remoteAudio.parentNode.removeChild(info.remoteAudio);
        }
      }
    }
    peers.clear();
  }

  function clearPendingCall(peerId, closeCall = true) {
    const pending = pendingCalls.get(peerId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (closeCall && pending.call) {
      try { pending.call.close(); } catch (_) {}
    }
    pendingCalls.delete(peerId);
  }

  function clearAllPendingCalls() {
    for (const peerId of pendingCalls.keys()) {
      clearPendingCall(peerId);
    }
  }

  function clearMeshScanTimer() {
    if (meshScanTimer) {
      clearInterval(meshScanTimer);
      meshScanTimer = null;
    }
  }

  function clearHostScanTimer() {
    if (hostScanTimer) {
      clearInterval(hostScanTimer);
      hostScanTimer = null;
    }
  }

  function startHostScan(token) {
    if (!peer || !peer.open || currentRole !== "host") return;
    if (hostScanTimer) return;
    const doScan = () => {
      if (!peer || !peer.open || currentRole !== "host" || peers.size > 0) {
        clearHostScanTimer();
        return;
      }
      for (let i = 0; i < MAX_PEERS; i++) {
        const guestId = `isay-${token}-g${i}`;
        if (!peers.has(guestId) && !pendingCalls.has(guestId)) {
          initiateCall(guestId, { maxAttempts: 1 });
        }
      }
    };
    // Delay first scan so guest has time to open its page
    setTimeout(doScan, 800);
    hostScanTimer = setInterval(doScan, MESH_SCAN_INTERVAL);
  }

  // ========== Connection monitoring (per-peer) ==========
  function monitorSinglePeerConnection(pc) {
    if (!pc || pc._isayMonitored) return;
    pc._isayMonitored = true;
    setupNetworkMigration();

    let disconnectedTimer = null;
    let connectingTimer = null;

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.debug("[iSay] peer connectionState:", state);
      if (state === "failed") {
        if (disconnectedTimer) { clearTimeout(disconnectedTimer); disconnectedTimer = null; }
        if (connectingTimer) { clearTimeout(connectingTimer); connectingTimer = null; }
        scheduleReconnect();
      } else if (state === "disconnected") {
        if (!disconnectedTimer) {
          disconnectedTimer = setTimeout(() => {
            disconnectedTimer = null;
            if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
              console.warn("[iSay] peer disconnected for 5s, triggering ICE restart");
              attemptICERestart(pc);
            }
          }, 5000);
        }
      } else if (state === "connected") {
        if (disconnectedTimer) { clearTimeout(disconnectedTimer); disconnectedTimer = null; }
        if (connectingTimer) { clearTimeout(connectingTimer); connectingTimer = null; }
      } else if (state === "connecting") {
        if (!connectingTimer) {
          connectingTimer = setTimeout(() => {
            connectingTimer = null;
            if (pc.connectionState === "connecting" || pc.connectionState === "disconnected") {
              console.warn("[iSay] peer stuck in connecting for 15s, triggering ICE restart");
              attemptICERestart(pc);
            }
          }, 15000);
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.debug("[iSay] peer iceConnectionState:", state);
      if (state === "connected" || state === "completed") {
        reconnectAttempts = 0;
        getQoSState(pc).bitrateAppliedOnce = false;
        startStatsMonitor();
      } else if (state === "failed") {
        scheduleReconnect();
      }
    };

    pc.onicegatheringstatechange = () => console.debug("[iSay] peer iceGatheringState:", pc.iceGatheringState);
    pc.onicecandidateerror = (err) => console.warn("[iSay] ICE candidate error:", {
      url: err.url,
      code: err.errorCode,
      text: err.errorText,
    });
    pc.onsignalingstatechange = () => console.debug("[iSay] peer signalingState:", pc.signalingState);
  }

  // ========== Duration ==========
  function startDurationTimer() {
    if (durationTimer) return;
    if (!callStartTime) callStartTime = Date.now();
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
    callStartTime = null;
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
  function generateQR(text, imgEl, size) {
    if (!generateQR._loaded) {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/qrcode@latest/build/qrcode.min.js";
      script.onload = () => { generateQR._loaded = true; generateQR(text, imgEl, size); };
      script.onerror = () => { imgEl.style.display = "none"; };
      document.head.appendChild(script);
      return;
    }
    try {
      QRCode.toDataURL(text, {
        width: size, margin: 2,
        color: { dark: "#4f9cf7", light: "#1a1a1a" },
        errorCorrectionLevel: "M",
      }, (err, url) => {
        if (!err && url) imgEl.src = url;
        else imgEl.style.display = "none";
      });
    } catch (_) { imgEl.style.display = "none"; }
  }

  // ========== Speaking detection ==========
  let rmsBuffer = new Uint8Array(256);
  function getRMS(analyser) {
    if (!analyser) return 0;
    const size = analyser.fftSize;
    if (rmsBuffer.length < size) rmsBuffer = new Uint8Array(size);
    analyser.getByteTimeDomainData(rmsBuffer);
    let sum = 0;
    for (let i = 0; i < size; i++) {
      const v = (rmsBuffer[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / size);
  }

  function updateSpeakingIndicators() {
    const localRMS = getRMS(localAnalyser);
    const localLabel = $("#label-local");
    if (localLabel) localLabel.classList.toggle("speaking", localRMS > 0.05 && !isMuted);

    // Check if ANY remote peer is speaking
    let anyRemoteSpeaking = false;
    for (const [, info] of peers) {
      if (getRMS(info.analyser) > 0.05) { anyRemoteSpeaking = true; break; }
    }
    const remoteLabel = $("#label-remote");
    if (remoteLabel) remoteLabel.classList.toggle("speaking", anyRemoteSpeaking);
  }

  // ========== Audio Visualizer ==========
  function initAudioViz() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
      } catch (_) { return; }
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});

    const localSrc = audioCtx.createMediaStreamSource(localStream);
    localAnalyser = audioCtx.createAnalyser();
    localAnalyser.fftSize = 256;
    localAnalyser.smoothingTimeConstant = 0.8;
    localSrc.connect(localAnalyser);

    drawVisualizer();
    setupCanvasResize();
    logAudioLatency();
    configureAudioSession();
  }

  let resizeTimer = null;
  function setupCanvasResize() {
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (vizRAF) { cancelAnimationFrame(vizRAF); vizRAF = null; }
        drawVisualizer();
      }, 150);
    };
    window.addEventListener("resize", onResize);
    if (screen.orientation) screen.orientation.addEventListener("change", onResize);
  }

  function logAudioLatency() {
    if (!audioCtx) return;
    const base = (audioCtx.baseLatency || 0) * 1000;
    const output = (audioCtx.outputLatency || 0) * 1000;
    const total = Math.round(base + output);
    if (total > 0) showToast(`Audio latency: ${total}ms`, 2500);
  }

  // Reusable buffers to reduce GC pressure during visualization
  const vizBuffers = {
    local: null,
    remote: null,
    peerTmp: new Map(), // peerId -> Uint8Array
  };

  function drawVisualizer() {
    const canvas = $("#visualizer");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) { requestAnimationFrame(() => drawVisualizer()); return; }
    const W = rect.width * dpr;
    const H = rect.height * dpr;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const logicalW = rect.width;
    const logicalH = rect.height;
    const bufLen = localAnalyser ? localAnalyser.frequencyBinCount : 128;
    if (!vizBuffers.local || vizBuffers.local.length !== bufLen) vizBuffers.local = new Uint8Array(bufLen);
    if (!vizBuffers.remote || vizBuffers.remote.length !== bufLen) vizBuffers.remote = new Uint8Array(bufLen);
    const localData = vizBuffers.local;
    const remoteMerged = vizBuffers.remote;

    function draw() {
      vizRAF = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, logicalW, logicalH);

      if (localAnalyser) localAnalyser.getByteFrequencyData(localData);

      // Merge all remote peer frequency data
      remoteMerged.fill(0);
      let remoteCount = 0;
      for (const [pid, info] of peers) {
        if (info.analyser) {
          let tmp = vizBuffers.peerTmp.get(pid);
          if (!tmp || tmp.length !== bufLen) {
            tmp = new Uint8Array(bufLen);
            vizBuffers.peerTmp.set(pid, tmp);
          }
          info.analyser.getByteFrequencyData(tmp);
          for (let i = 0; i < bufLen; i++) {
            if (tmp[i] > remoteMerged[i]) remoteMerged[i] = tmp[i];
          }
          remoteCount++;
        }
      }
      // Clean up buffers for disconnected peers
      for (const pid of vizBuffers.peerTmp.keys()) {
        if (!peers.has(pid)) vizBuffers.peerTmp.delete(pid);
      }

      const barCount = 40;
      const barW = (logicalW - (barCount - 1) * 2) / barCount;
      const step = Math.floor(bufLen / barCount);

      drawBars(ctx, remoteMerged, barCount, barW, step, logicalW, logicalH, "#22c55e", 0.7, true);
      drawBars(ctx, localData, barCount, barW, step, logicalW, logicalH, "#4f9cf7", 0.8, false);
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
      if (fromBottom) roundRect(ctx, x, centerY - barH, barW, barH, Math.min(barW / 2, 3));
      else roundRect(ctx, x, centerY, barW, barH, Math.min(barW / 2, 3));
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
    clearTimeout(resizeTimer);
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    vizBuffers.local = null;
    vizBuffers.remote = null;
    vizBuffers.peerTmp.clear();
  }

  // ========== Connection quality monitoring ==========
  function getQoSState(pc) {
    let state = qosByConnection.get(pc);
    if (!state) {
      state = { prevStats: {}, consecBad: 0, bitrateAppliedOnce: false, lastIceRestart: 0 };
      qosByConnection.set(pc, state);
    }
    return state;
  }

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
    if (lastQualityScore >= 4 && level <= 2 && level > 0) showToast("Quality degraded.");
    else if (lastQualityScore <= 2 && level >= 4) showToast("Quality restored.");
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
      setQuality(score, { 1: "Terrible", 2: "Poor", 3: "Fair", 4: "Good", 5: "Excellent" }[score]);
    }
  }

  let statsPaused = false;
  let statsInFlight = false;
  let glitchStats = { lastTs: 0 };
  function startStatsMonitor() {
    if (statsInterval) return; // Already running
    statsInterval = setInterval(async () => {
      if (statsPaused) return;
      if (statsInFlight) return;
      statsInFlight = true;
      try {
        const connectedPeers = [...peers.values()]
          .map((info) => info.call?.peerConnection)
          .filter((pc) => pc && pc.connectionState !== "closed");

        if (!connectedPeers.length) { stopStatsMonitor(); return; }

        const snapshots = await Promise.all(connectedPeers.map((pc) => collectConnectionStats(pc)));
        const validSnapshots = snapshots.filter(Boolean);
        if (!validSnapshots.length) return;

        const worstLatency = Math.max(...validSnapshots.map((s) => s.latency).filter((v) => v >= 0), -1);
        const worstJitter = Math.max(...validSnapshots.map((s) => s.jitter).filter((v) => v >= 0), -1);
        const worstLoss = Math.max(...validSnapshots.map((s) => s.loss).filter((v) => v >= 0), -1);
        updateMetrics(worstLatency, worstJitter, worstLoss);
        setConnType(validSnapshots.some((s) => s.isRelay) ? "relay" : "p2p");

        for (const snapshot of validSnapshots) {
          const { pc, latency, jitter, loss, rtt } = snapshot;
          const safeLoss = loss >= 0 ? loss : 0;
          const safeJitter = jitter >= 0 ? jitter : 0;
          adaptAudioBitrate(pc, safeLoss, safeJitter, rtt);
          configureJitterBuffer(pc, jitter);

          const qos = getQoSState(pc);
          if (safeLoss > 12 || latency > 400) {
            qos.consecBad++;
            if (qos.consecBad >= 2) { attemptICERestart(pc); qos.consecBad = 0; }
          } else if (safeLoss < 5 && latency >= 0 && latency < 200) {
            qos.consecBad = Math.max(0, qos.consecBad - 1);
          }
        }
      } finally {
        statsInFlight = false;
      }
    }, 2000);
  }

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
      const qos = getQoSState(pc);

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

          const dConcealed = Math.max(0, (report.concealedSamples || 0) - prev.concealedSamples);
          const dTotalSamples = Math.max(0, (report.totalSamplesReceived || 0) - prev.totalSamplesReceived);
          if (dTotalSamples > 0 && dConcealed > 0) {
            const glitchRate = dConcealed / dTotalSamples;
            if (glitchRate > 0.03) {
              const now = Date.now();
              if (now - glitchStats.lastTs > 8000) {
                glitchStats.lastTs = now;
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
      if (recvDelta + lostDelta > 0) loss = (lostDelta / (recvDelta + lostDelta)) * 100;
      else if (totalPackets > 0) loss = (lostPackets / totalPackets) * 100;

      return { pc, latency, jitter, loss, rtt, isRelay };
    } catch (_) {
      return null;
    }
  }

  function stopStatsMonitor() {
    clearInterval(statsInterval);
    statsInterval = null;
    statsInFlight = false;
    lastQualityScore = -1;
  }

  // ========== ICE restart & reconnection ==========
  function attemptICERestart(pc) {
    const target = pc || (peers.values().next().value?.call?.peerConnection);
    if (!target) return;
    const now = Date.now();
    const qos = getQoSState(target);
    if (now - qos.lastIceRestart < 10000) return;
    qos.lastIceRestart = now;
    try {
      target.restartIce();
      // Let browser fire onnegotiationneeded; PeerJS internal Negotiator
      // listens to that event and will re-offer automatically.
    } catch (e) {
      console.warn("[iSay] restartIce failed:", e);
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      endCall("Connection lost. Max reconnection attempts reached.");
      return;
    }

    // In mesh: if some peers are still healthy, only reconnect the broken ones
    if (peers.size > 1) {
      const deadPeerIds = [];
      for (const [pid, info] of peers) {
        const pc = info.call?.peerConnection;
        if (!pc || pc.connectionState === "failed" || pc.iceConnectionState === "failed") {
          deadPeerIds.push(pid);
        }
      }
      if (deadPeerIds.length > 0) {
        for (const pid of deadPeerIds) {
          removePeer(pid);
          if (currentPeerId && currentToken) {
            const targetId = pid; // peerId is the full PeerJS id
            setTimeout(() => {
              if (peer && peer.open) initiateCall(targetId, { maxAttempts: 2, retryDelays: [1000, 3000] });
            }, 500);
          }
        }
        // If all peers died, fall through to global reconnect instead of returning
        if (peers.size > 0) return;
      }
    }

    const delay = RECONNECT_BACKOFF[Math.min(reconnectAttempts, RECONNECT_BACKOFF.length - 1)];
    setConnType("disconnected");
    updateMetrics(-1, -1, -1);
    setQuality(0, "Reconnecting...");
    announce("Connection lost. Reconnecting.");

    reconnectTimer = setTimeout(async () => {
      reconnectAttempts++;
      if (!currentToken) { endCall("Connection lost."); return; }
      closeAllPeers();
      stopAudioViz();
      stopStatsMonitor();
      destroyPeer();
      showScreen("waiting");
      if (currentToken) showShareLink(currentToken);
      setPhase("signaling");
      try {
        await connectPeer(currentToken);
      } catch (err) {
        endCall("Reconnection failed: " + (err.message || "unknown error"));
      }
    }, delay);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  // ========== Mesh connection handling ==========
  function handleIncomingCall(call) {
    if (peers.has(call.peer)) {
      try { call.close(); } catch (_) {}
      return;
    }
    applySDPOptimization(call);
    monitorSinglePeerConnection(call.peerConnection);

    // Guard against zombie calls: if stream never arrives after answer, close it
    let streamTimer = null;
    const clearStreamTimer = () => {
      if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
    };

    call.on("stream", (remoteStream) => {
      clearStreamTimer();
      addPeer(call.peer, call, remoteStream);
    });
    call.on("close", () => { clearStreamTimer(); removePeer(call.peer, false); });
    call.on("error", (err) => {
      clearStreamTimer();
      console.warn("[iSay] incoming call error:", call.peer, err);
      removePeer(call.peer);
    });
    // Fallback: if PeerJS stream event is missed (known Safari/PeerJS bug),
    // manually recover from RTCRtpReceivers once ICE is up.
    const pcIn = call.peerConnection;
    if (pcIn) {
      const recoverStream = () => {
        if (peers.has(call.peer)) return;
        if ((pcIn.connectionState === "connected" || pcIn.connectionState === "connecting") && pcIn.getReceivers) {
          const receivers = pcIn.getReceivers().filter((r) => r.track && r.track.kind === "audio" && r.track.readyState !== "ended");
          if (receivers.length > 0) {
            console.warn("[iSay] incoming call stream event missed, recovering from receivers:", call.peer);
            addPeer(call.peer, call, new MediaStream(receivers.map((r) => r.track)));
          }
        }
      };
      setTimeout(recoverStream, 6000);
      setTimeout(recoverStream, 12000);
    }
    const doAnswer = () => {
      if (!localStream) {
        setTimeout(doAnswer, 100);
        return;
      }
      try {
        call.answer(localStream);
        // If no stream within 18s after answer, kill this call so caller can retry
        streamTimer = setTimeout(() => {
          if (!peers.has(call.peer)) {
            console.warn("[iSay] incoming call stream timeout:", call.peer);
            try { call.close(); } catch (_) {}
          }
        }, CALL_STREAM_TIMEOUT);
      } catch (err) {
        console.warn("[iSay] answer failed:", call.peer, err);
        try { call.close(); } catch (_) {}
      }
    };
    doAnswer();
  }

  async function initiateCall(targetPeerId, options = {}) {
    if (!peer || !peer.open || targetPeerId === peer.id) return;
    if (peers.has(targetPeerId) || pendingCalls.has(targetPeerId)) return;
    // Cap concurrent dialing attempts to avoid signaling channel saturation
    if (pendingCalls.size >= 4) return;
    // Safari/iOS may stop tracks when backgrounded; re-acquire if needed
    if (!localStream || localStream.getAudioTracks().length === 0 || localStream.getAudioTracks().every((t) => !t.enabled || t.readyState === "ended")) {
      try {
        localStream = null;
        await getLocalStream();
      } catch (e) {
        console.warn("[iSay] failed to re-acquire local stream:", e);
        return;
      }
    }

    const attempt = options.attempt || 1;
    const maxAttempts = options.maxAttempts || 1;
    const call = peer.call(targetPeerId, localStream);
    if (!call) {
      retryCall(targetPeerId, options);
      return;
    }

    console.debug("[iSay] dialing peer:", targetPeerId, "attempt:", attempt);
    // PeerJS creates peerConnection asynchronously; retry patch/monitor at multiple intervals
    [0, 50, 150, 400].forEach((ms) => {
      setTimeout(() => {
        applySDPOptimization(call);
        monitorSinglePeerConnection(call.peerConnection);
      }, ms);
    });

    const timer = setTimeout(() => {
      if (peers.has(targetPeerId)) return;
      console.warn("[iSay] call stream timeout:", targetPeerId, "attempt:", attempt);
      clearPendingCall(targetPeerId);
      if (attempt < maxAttempts) {
        const retryDelays = options.retryDelays || [];
        const retryDelay = retryDelays[attempt] ?? 1500;
        setTimeout(() => initiateCall(targetPeerId, { ...options, attempt: attempt + 1 }), retryDelay);
      } else if (options.required && peers.size === 0 && currentToken) {
        startMeshScan(currentToken);
      }
    }, CALL_STREAM_TIMEOUT);

    pendingCalls.set(targetPeerId, { call, timer, attempts: attempt });

    call.on("stream", (remoteStream) => {
      addPeer(targetPeerId, call, remoteStream);
    });
    call.on("close", () => {
      clearPendingCall(targetPeerId, false);
      removePeer(targetPeerId, false);
    });
    call.on("error", (err) => {
      console.warn("[iSay] outgoing call error:", targetPeerId, err);
      clearPendingCall(targetPeerId, false);
      removePeer(targetPeerId);
      if (!peers.has(targetPeerId) && attempt < maxAttempts) {
        retryCall(targetPeerId, options);
      } else if (options.required && peers.size === 0 && currentToken) {
        startMeshScan(currentToken);
      }
    });
    // Fallback: if PeerJS stream event is missed (known Safari/PeerJS bug),
    // manually recover from RTCRtpReceivers once ICE is up.
    const pcOut = call.peerConnection;
    if (pcOut) {
      const recoverStream = () => {
        if (peers.has(targetPeerId)) return;
        if ((pcOut.connectionState === "connected" || pcOut.connectionState === "connecting") && pcOut.getReceivers) {
          const receivers = pcOut.getReceivers().filter((r) => r.track && r.track.kind === "audio" && r.track.readyState !== "ended");
          if (receivers.length > 0) {
            console.warn("[iSay] outgoing call stream event missed, recovering from receivers:", targetPeerId);
            addPeer(targetPeerId, call, new MediaStream(receivers.map((r) => r.track)));
          }
        }
      };
      setTimeout(recoverStream, 6000);
      setTimeout(recoverStream, 12000);
    }
  }

  function retryCall(targetPeerId, options) {
    const attempt = options.attempt || 1;
    const maxAttempts = options.maxAttempts || 1;
    if (attempt >= maxAttempts) return;
    const retryDelays = options.retryDelays || [];
    const retryDelay = retryDelays[attempt] ?? 1500;
    setTimeout(() => initiateCall(targetPeerId, { ...options, attempt: attempt + 1 }), retryDelay);
  }

  let lastMeshScanTime = 0;
  function startMeshScan(token) {
    if (!peer || !peer.open || peers.size > 0) return;
    const now = Date.now();
    if (now - lastMeshScanTime < 4000) return; // throttle to avoid storm
    lastMeshScanTime = now;
    setPhase("ice");
    showToast("Still waiting for the other side. Retrying...", 2500);
    scanRoomPeers(token);
    if (meshScanTimer) return;
    meshScanTimer = setInterval(() => {
      if (!peer || !peer.open || peers.size > 0 || !currentToken) {
        clearMeshScanTimer();
        return;
      }
      scanRoomPeers(currentToken);
    }, MESH_SCAN_INTERVAL);
  }

  function scanRoomPeers(token) {
    if (!peer || !peer.open || !currentPeerId) return;
    const hostId = `isay-${token}-host`;
    initiateCall(hostId, { maxAttempts: 1 });
    for (let i = 0; i < MAX_PEERS; i++) {
      const guestId = `isay-${token}-g${i}`;
      if (guestId !== currentPeerId) initiateCall(guestId, { maxAttempts: 1 });
    }
  }

  // ========== PeerJS connection ==========
  function attachPeerLifecycleHandlers(p) {
    p.on("disconnected", () => {
      console.warn("[iSay] PeerJS signaling disconnected");
      if (peer !== p || p.destroyed) return;
      setPhase("signaling");
      let reconTries = 0;
      const doReconnect = () => {
        if (peer !== p || p.destroyed || !p.disconnected) return;
        reconTries++;
        try { p.reconnect(); } catch (_) {}
        if (reconTries < 3) {
          setTimeout(doReconnect, 1000 * reconTries);
        } else if (peers.size === 0 && currentToken) {
          scheduleReconnect();
        }
      };
      setTimeout(doReconnect, 500);
    });

    p.on("close", () => {
      console.warn("[iSay] PeerJS connection closed");
      if (peer === p) clearAllPendingCalls();
    });

    p.on("error", (err) => {
      console.error("[iSay] PeerJS error:", err.type, err.message);
    });
  }

  async function connectPeer(token) {
    currentToken = token;
    currentRole = null;
    currentPeerId = null;

    try {
      await getLocalStream();
    } catch (err) {
      const name = err.name;
      if (name === "NotAllowedError") throw new Error("Microphone blocked. Allow in browser settings, then reload.");
      if (name === "NotFoundError") throw new Error("No microphone detected. Connect a headset.");
      if (name === "NotReadableError") throw new Error("Microphone in use. Close Zoom/Teams and retry.");
      throw new Error("Microphone access denied.");
    }

    setPhase("signaling");

    // Try to claim host slot
    const hostId = `isay-${token}-host`;
    return new Promise((resolve, reject) => {
      let aborted = false;
      const abort = () => { aborted = true; };
      // Store abort hook so UI cancel can stop the connection attempt
      connectPeer._abort = abort;

      const timeout = setTimeout(() => {
        if (aborted) return;
        if (!currentRole) {
          try { p.destroy(); } catch (_) {}
          reject(new Error("Connection timed out. Make sure the other person has the link open."));
        }
      }, 12000);

      const p = new Peer(hostId, { debug: 0, config: ICE_CONFIG });
      attachPeerLifecycleHandlers(p);

      p.on("open", () => {
        currentRole = "host";
        currentPeerId = hostId;
        peer = p;
        setPhase("ice");
        clearTimeout(timeout);

        // Listen for all incoming calls (mesh)
        p.on("call", (call) => handleIncomingCall(call));
        initAudioViz();
        // Host also scans guest slots (bidirectional discovery)
        startHostScan(token);
        resolve({ role: "host" });
      });

      p.on("error", (err) => {
        if (aborted) { try { p.destroy(); } catch (_) {} return; }
        if (err.type === "unavailable-id" && !currentRole) {
          // Host taken - become guest
          p.destroy();
          let guestIdx = 0;
          const tryGuest = () => {
            if (aborted) {
              clearTimeout(timeout);
              reject(new Error("Cancelled."));
              return;
            }
            if (guestIdx >= MAX_PEERS) {
              clearTimeout(timeout);
              reject(new Error("Room is full."));
              return;
            }
            const guestId = `isay-${token}-g${guestIdx}`;
            const gp = new Peer(guestId, { debug: 0, config: ICE_CONFIG });
            attachPeerLifecycleHandlers(gp);

            gp.on("open", () => {
              currentRole = "guest";
              currentPeerId = guestId;
              peer = gp;
              setPhase("ice");
              clearTimeout(timeout);

              gp.on("call", (call) => handleIncomingCall(call));

              // Initiate audio viz for local stream
              initAudioViz();

              // Connect to host first. Small delay lets PeerJS server sync host state.
              setTimeout(() => {
                if (peer && peer.open) {
                  initiateCall(hostId, { maxAttempts: HOST_RETRY_DELAYS.length, retryDelays: HOST_RETRY_DELAYS, required: true });
                }
              }, 400);
              // Also proactively scan backwards in case our call to host was dropped by signaling server
              for (let i = 0; i < guestIdx; i++) {
                const id = `isay-${token}-g${i}`;
                setTimeout(() => {
                  if (peer && peer.open) initiateCall(id, { maxAttempts: 1 });
                }, MESH_CONNECT_DELAY + i * 250);
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
        } else if (!currentRole) {
          clearTimeout(timeout);
          reject(err);
        }
      });
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
    const qrImg = $("#qr-img");
    if (qrImg) generateQR(link, qrImg, 160);
  }

  function copyShareLink() {
    const link = $("#share-link").value;
    const hint = $("#copy-hint");
    const btn = $("#btn-copy-link");
    const showCopied = () => {
      btn.classList.add("copied");
      hint.textContent = "Copied!";
      haptic(20);
      setTimeout(() => { btn.classList.remove("copied"); hint.textContent = ""; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(showCopied).catch(() => fallbackCopy(link, hint, showCopied));
    } else {
      fallbackCopy(link, hint, showCopied);
    }
  }

  function fallbackCopy(text, hintEl, onSuccess) {
    const input = $("#share-link");
    input.select();
    input.setSelectionRange(0, 99999);
    try { document.execCommand("copy"); onSuccess(); }
    catch (_) { hintEl.textContent = "Press Ctrl+C to copy"; }
  }

  function haptic(pattern) {
    if ("vibrate" in navigator) { try { navigator.vibrate(pattern); } catch (_) {} }
  }

  // --- UI Events ---
  async function joinRoom(token) {
    if (typeof token !== "string") token = $("#token-input").value;
    token = token.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
    if (!token) { $("#token-input").focus(); return; }

    // Unlock autoplay as early as possible (must be inside user-gesture handler)
    unlockAudio();

    // iOS requires AudioContext.resume() inside a user gesture.
    // Create / resume it here so addPeer can safely connect streams to destination.
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
      }
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
    } catch (_) {}

    setPhase("signaling");
    showScreen("waiting");
    showShareLink(token);

    try {
      await connectPeer(token);
      // Host stays on waiting screen until someone joins
      // Guest: if no one else is in the room yet, show waiting
      if (peers.size === 0) {
        // Waiting for others to connect back to us
      }
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
    announce(isMuted ? "Muted" : "Unmuted");
  }

  function endCall(reason) {
    clearReconnectTimer();
    clearMeshScanTimer();
    clearHostScanTimer();
    stopDurationTimer();
    stopAudioViz();
    stopStatsMonitor();
    releaseWakeLock();
    reconnectAttempts = 0;
    closeAllPeers();
    stopLocalStream();
    destroyPeer();
    currentPeerId = null;
    lastMeshScanTime = 0;
    // Reset audio session
    if ("audioSession" in navigator) {
      try { navigator.audioSession.type = "auto"; } catch (_) {}
    }
    $("#disconnect-reason").textContent = reason || "The call has ended";
    const titleEl = $("#disconnect-title");
    if (titleEl) {
      titleEl.textContent = (reason && (reason.includes("lost") || reason.includes("failed"))) ? "Connection Lost" : "Call Ended";
    }
    const retryBtn = $("#btn-retry");
    if (retryBtn) retryBtn.style.display = currentToken ? "" : "none";
    announce("Call ended. " + (reason || ""));
    showScreen("disconnected");
  }

  function destroyPeer() {
    currentPeerId = null;
    clearAllPendingCalls();
    if (peer) {
      try { peer.destroy(); } catch (_) {}
      peer = null;
    }
  }

  function restart() {
    closeAllPeers();
    stopLocalStream();
    stopAudioViz();
    stopStatsMonitor();
    clearReconnectTimer();
    clearMeshScanTimer();
    clearHostScanTimer();
    releaseWakeLock();
    reconnectAttempts = 0;
    currentToken = null;
    currentRole = null;
    currentPeerId = null;
    isMuted = false;
    speakerOn = true;
    currentAudioOutput = "default";
    $("#token-input").value = generateToken();
    $("#btn-mute").classList.remove("muted");
    $("#icon-mic-on").style.display = "";
    $("#icon-mic-off").style.display = "none";
    $("#mute-label").textContent = "Mute";
    const spkBtn = $("#btn-speaker");
    if (spkBtn) spkBtn.classList.remove("speaker-off");
    const iconSpk = $("#icon-speaker");
    const iconEar = $("#icon-earpiece");
    if (iconSpk) iconSpk.style.display = "";
    if (iconEar) iconEar.style.display = "none";
    const spkLabel = $("#speaker-label");
    if (spkLabel) spkLabel.textContent = "Speaker";
    showScreen("landing");
  }

  // ========== Background / Foreground ==========
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      statsPaused = false;
      if (peers.size > 0) {
        await requestWakeLock();
        if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      }
    } else {
      statsPaused = true;
    }
  });

  // ========== Event binding ==========
  $("#btn-join").addEventListener("click", () => joinRoom());
  $("#token-input").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  $("#btn-copy-link").addEventListener("click", copyShareLink);
  $("#btn-cancel-wait").addEventListener("click", () => {
    if (typeof connectPeer === "function" && connectPeer._abort) connectPeer._abort();
    destroyPeer(); stopLocalStream(); closeAllPeers(); showScreen("landing");
  });
  $("#btn-mute").addEventListener("click", toggleMute);
  const speakerBtn = $("#btn-speaker");
  if (speakerBtn) speakerBtn.addEventListener("click", toggleSpeaker);
  $("#btn-hangup").addEventListener("click", () => endCall("You ended the call"));
  $("#btn-restart").addEventListener("click", restart);
  $("#btn-retry").addEventListener("click", () => { if (currentToken) joinRoom(currentToken); else restart(); });

  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && peers.size > 0 && !e.repeat) { e.preventDefault(); toggleMute(); }
  });

  // ========== Init ==========
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
  if (compatIssues.includes("https")) showToast("HTTPS required. Open via https:// or localhost.", 8000);

  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const urlToken = hashParams.get("token") || hashParams.get("room");
  if (urlToken) joinRoom(urlToken);
  else $("#token-input").value = generateToken();
})();
