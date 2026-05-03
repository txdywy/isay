(() => {
  "use strict";

  // --- State ---
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

  // --- ICE config ---
  const ICE_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
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
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return localStream;
  }

  function stopLocalStream() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
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

    const lines = document.querySelectorAll(".phase-line");
    lines.forEach((line, i) => {
      line.classList.toggle("done", i < idx);
      line.classList.toggle("active", i === idx);
    });

    const lbl = $("#phase-label");
    if (lbl) lbl.textContent = label[name] || "";
  }

  // ========== Audio Visualizer ==========
  function initAudioViz(remoteStream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) {
      return;
    }

    // Local analyser
    const localSrc = audioCtx.createMediaStreamSource(localStream);
    localAnalyser = audioCtx.createAnalyser();
    localAnalyser.fftSize = 256;
    localSrc.connect(localAnalyser);

    // Remote analyser
    if (remoteStream) {
      const remoteSrc = audioCtx.createMediaStreamSource(remoteStream);
      remoteAnalyser = audioCtx.createAnalyser();
      remoteAnalyser.fftSize = 256;
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

      // Draw remote (bottom half, green)
      drawBars(ctx, remoteData, barCount, barW, step, W, H, "#22c55e", 0.7, true);
      // Draw local (top half, blue)
      drawBars(ctx, localData, barCount, barW, step, W, H, "#4f9cf7", 0.8, false);
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

      if (fromBottom) {
        roundRect(ctx, x, centerY - barH, barW, barH, radius);
      } else {
        roundRect(ctx, x, centerY, barW, barH, radius);
      }
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
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
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
  }

  function updateMetrics(latency, jitter, loss) {
    const lv = $("#metric-latency");
    const jv = $("#metric-jitter");
    const lo = $("#metric-loss");

    lv.textContent = latency >= 0 ? Math.round(latency) : "--";
    jv.textContent = jitter >= 0 ? Math.round(jitter) : "--";
    lo.textContent = loss >= 0 ? loss.toFixed(1) + "%" : "--";

    // Color code latency
    lv.style.color = latency < 0 ? "" : latency < 100 ? "var(--success)" : latency < 300 ? "var(--warning)" : "var(--danger)";
    jv.style.color = jitter < 0 ? "" : jitter < 30 ? "var(--success)" : jitter < 80 ? "var(--warning)" : "var(--danger)";
    lo.style.color = loss < 0 ? "" : loss < 2 ? "var(--success)" : loss < 5 ? "var(--warning)" : "var(--danger)";

    // Overall quality score (1-5)
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
    statsInterval = setInterval(() => {
      if (!pc || pc.connectionState === "closed") {
        stopStatsMonitor();
        return;
      }
      pc.getStats().then((stats) => {
        let isRelay = false;
        let currentPair = null;

        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded") {
            currentPair = report;
          }
          if (report.type === "local-candidate" && report.candidateType === "relay") {
            isRelay = true;
          }
        });

        if (currentPair) {
          const latency = currentPair.currentRoundTripTime ? currentPair.currentRoundTripTime * 1000 : -1;

          // Calculate packet loss from inbound-rtp
          let loss = -1;
          let jitter = -1;
          stats.forEach((report) => {
            if (report.type === "inbound-rtp" && report.kind === "audio") {
              const total = report.packetsReceived + (report.packetsLost || 0);
              if (total > 0) {
                loss = ((report.packetsLost || 0) / total) * 100;
              }
              if (report.jitter !== undefined) {
                jitter = report.jitter * 1000;
              }
            }
          });

          updateMetrics(latency, jitter, loss);
          setConnType(isRelay ? "relay" : "p2p");
        }
      }).catch(() => {});
    }, 2000);
  }

  function stopStatsMonitor() {
    clearInterval(statsInterval);
    statsInterval = null;
    prevStats = null;
  }

  // ========== Peer connection monitoring ==========
  function monitorPeerConnection(call) {
    const pc = call.peerConnection;
    if (!pc) return;

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      switch (state) {
        case "checking":
          setConnType("checking");
          break;
        case "connected":
        case "completed":
          startStatsMonitor(pc);
          break;
        case "disconnected":
          setConnType("disconnected");
          updateMetrics(-1, -1, -1);
          setQuality(0, "Reconnecting");
          break;
        case "failed":
          setConnType("failed");
          endCall("Connection failed. Network may be too restrictive.");
          break;
      }
    };
  }

  // --- Call handling ---
  function handleCall(call) {
    currentCall = call;
    clearCallTimeout();
    setPhase("connected");

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
    // Short delay so phase transition animation plays before switching screen
    setTimeout(() => showScreen("call"), 400);
  }

  // --- Call timeout ---
  let callTimeoutId = null;

  function setCallTimeout() {
    clearCallTimeout();
    callTimeoutId = setTimeout(() => {
      endCall("No answer. The other user may have left.");
    }, 15000);
  }

  function clearCallTimeout() {
    if (callTimeoutId) {
      clearTimeout(callTimeoutId);
      callTimeoutId = null;
    }
  }

  function endCall(reason) {
    clearCallTimeout();
    stopDurationTimer();
    stopAudioViz();
    stopStatsMonitor();
    if (currentCall) {
      currentCall.close();
      if (currentCall._remoteAudio) {
        currentCall._remoteAudio.pause();
        currentCall._remoteAudio.srcObject = null;
      }
      currentCall = null;
    }
    stopLocalStream();
    destroyPeer();
    $("#disconnect-reason").textContent = reason || "The call has ended";
    showScreen("disconnected");
  }

  function destroyPeer() {
    if (peer) {
      peer.destroy();
      peer = null;
    }
  }

  // --- PeerJS connection ---
  async function connectPeer(token) {
    const hostId = `isay-${token}-host`;

    return new Promise(async (resolve, reject) => {
      try {
        await getLocalStream();
      } catch (err) {
        reject(new Error("Microphone access denied. Please allow microphone permission."));
        return;
      }

      setPhase("signaling");

      let isHost = false;

      const p = new Peer(hostId, {
        debug: 0,
        config: ICE_CONFIG,
      });

      p.on("open", (id) => {
        isHost = true;
        setPhase("ice");
        p.on("call", (call) => {
          call.answer(localStream);
          handleCall(call);
        });
        resolve({ peer: p, role: "host" });
      });

      p.on("error", (err) => {
        if (err.type === "unavailable-id" && !isHost) {
          p.destroy();
          const guestId = `isay-${token}-guest-${Math.random().toString(36).slice(2, 8)}`;
          const guestPeer = new Peer(guestId, {
            debug: 0,
            config: ICE_CONFIG,
          });

          guestPeer.on("open", () => {
            setPhase("ice");
            const call = guestPeer.call(hostId, localStream);
            if (call) {
              setCallTimeout();
              handleCall(call);
            } else {
              reject(new Error("Failed to initiate call"));
              return;
            }
            resolve({ peer: guestPeer, role: "guest" });
          });

          guestPeer.on("error", (guestErr) => {
            reject(guestErr);
          });
        } else if (!isHost) {
          reject(err);
        }
      });

      setTimeout(() => {
        if (!isHost && !peer) {
          p.destroy();
          reject(new Error("Connection timed out"));
        }
      }, 10000);
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
  }

  function copyShareLink() {
    const link = $("#share-link").value;
    const hint = $("#copy-hint");
    const btn = $("#btn-copy-link");

    if (navigator.share) {
      navigator.share({ title: "iSay Voice Chat", url: link }).catch(() => {});
      return;
    }

    navigator.clipboard.writeText(link).then(() => {
      btn.classList.add("copied");
      hint.textContent = "Copied!";
      setTimeout(() => {
        btn.classList.remove("copied");
        hint.textContent = "";
      }, 2000);
    }).catch(() => {
      $("#share-link").select();
      hint.textContent = "Press Ctrl+C to copy";
    });
  }

  // --- UI Events ---
  async function joinRoom(token) {
    if (typeof token !== "string") {
      token = $("#token-input").value;
    }
    token = token.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
    if (!token) {
      $("#token-input").focus();
      return;
    }

    showShareLink(token);
    setPhase("signaling");
    showScreen("waiting");

    try {
      const result = await connectPeer(token);
      peer = result.peer;

      if (result.role === "host") {
        $("#call-status-text").textContent = "Connected";
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
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted;
    });
    $("#btn-mute").classList.toggle("muted", isMuted);
    $("#icon-mic-on").style.display = isMuted ? "none" : "";
    $("#icon-mic-off").style.display = isMuted ? "" : "none";
    $("#mute-label").textContent = isMuted ? "Unmute" : "Mute";
  }

  function restart() {
    destroyPeer();
    stopLocalStream();
    stopAudioViz();
    stopStatsMonitor();
    isMuted = false;
    $("#token-input").value = "";
    $("#btn-mute").classList.remove("muted");
    $("#icon-mic-on").style.display = "";
    $("#icon-mic-off").style.display = "none";
    $("#mute-label").textContent = "Mute";
    showScreen("landing");
  }

  // --- Event binding ---
  $("#btn-join").addEventListener("click", () => joinRoom());
  $("#token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom();
  });
  $("#btn-copy-link").addEventListener("click", copyShareLink);
  $("#btn-cancel-wait").addEventListener("click", () => {
    destroyPeer();
    stopLocalStream();
    showScreen("landing");
  });
  $("#btn-mute").addEventListener("click", toggleMute);
  $("#btn-hangup").addEventListener("click", () => endCall("You ended the call"));
  $("#btn-restart").addEventListener("click", restart);

  // Auto-connect if token in URL hash
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const urlToken = hashParams.get("token") || hashParams.get("room");
  if (urlToken) {
    joinRoom(urlToken);
  }
})();
