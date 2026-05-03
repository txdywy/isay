(() => {
  "use strict";

  // --- State ---
  let peer = null;
  let currentCall = null;
  let localStream = null;
  let isMuted = false;
  let callStartTime = null;
  let durationTimer = null;

  // --- ICE config (STUN + TURN for 5G/CGNAT) ---
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

  // --- Connection status ---
  function updateConnectionStatus(text) {
    const el = $("#call-conn-status");
    if (el) el.textContent = text;
  }

  function monitorPeerConnection(call) {
    const pc = call.peerConnection;
    if (!pc) return;

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      switch (state) {
        case "checking":
          updateConnectionStatus("Connecting...");
          break;
        case "connected":
        case "completed":
          // Use getStats to detect if TURN relay is being used
          pc.getStats().then((stats) => {
            let isRelay = false;
            stats.forEach((report) => {
              if (report.type === "candidate-pair" && report.selectedCandidatePairId) {
                const local = stats.get(report.localCandidateId);
                if (local && local.candidateType === "relay") isRelay = true;
              }
              if (report.type === "local-candidate" && report.candidateType === "relay") {
                isRelay = true;
              }
            });
            updateConnectionStatus(isRelay ? "Relay mode (TURN)" : "Direct P2P");
          }).catch(() => {
            updateConnectionStatus("Connected");
          });
          break;
        case "disconnected":
          updateConnectionStatus("Reconnecting...");
          break;
        case "failed":
          endCall("Connection failed. Network may be too restrictive.");
          break;
      }
    };
  }

  // --- Call handling ---
  function handleCall(call) {
    currentCall = call;
    clearCallTimeout();

    call.on("stream", (remoteStream) => {
      const audio = new Audio();
      audio.srcObject = remoteStream;
      audio.autoplay = true;
      currentCall._remoteAudio = audio;
    });

    call.on("close", () => {
      endCall("Peer disconnected");
    });

    call.on("error", (err) => {
      endCall("Call error: " + err.type);
    });

    monitorPeerConnection(call);
    showScreen("call");
    startDurationTimer();
  }

  // --- Call timeout (for guest: host may be stale) ---
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

      // Try to become host first
      let isHost = false;

      const p = new Peer(hostId, {
        debug: 0,
        config: ICE_CONFIG,
      });

      p.on("open", (id) => {
        isHost = true;
        // We are the host, wait for incoming call
        p.on("call", (call) => {
          call.answer(localStream);
          handleCall(call);
        });
        resolve({ peer: p, role: "host" });
      });

      p.on("error", (err) => {
        if (err.type === "unavailable-id" && !isHost) {
          // Host ID taken - become guest and call the host
          p.destroy();
          const guestId = `isay-${token}-guest-${Math.random().toString(36).slice(2, 8)}`;
          const guestPeer = new Peer(guestId, {
            debug: 0,
            config: ICE_CONFIG,
          });

          guestPeer.on("open", () => {
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

      // Timeout - if neither open nor error in 10s
      setTimeout(() => {
        if (!isHost && !peer) {
          p.destroy();
          reject(new Error("Connection timed out"));
        }
      }, 10000);
    });
  }

  // --- UI Events ---
  async function joinRoom() {
    const tokenInput = $("#token-input");
    const token = tokenInput.value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
    if (!token) {
      tokenInput.focus();
      return;
    }

    $("#token-display").textContent = token;
    showScreen("waiting");

    try {
      const result = await connectPeer(token);
      peer = result.peer;

      if (result.role === "host") {
        // Already showing waiting screen, just wait for call event
        $("#call-status-text").textContent = "Connected";
      }
      // Guest: call is already initiated, handleCall will show call screen
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
    isMuted = false;
    $("#token-input").value = "";
    $("#btn-mute").classList.remove("muted");
    $("#icon-mic-on").style.display = "";
    $("#icon-mic-off").style.display = "none";
    $("#mute-label").textContent = "Mute";
    showScreen("landing");
  }

  // --- Event binding ---
  $("#btn-join").addEventListener("click", joinRoom);
  $("#token-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom();
  });
  $("#btn-cancel-wait").addEventListener("click", () => {
    destroyPeer();
    stopLocalStream();
    showScreen("landing");
  });
  $("#btn-mute").addEventListener("click", toggleMute);
  $("#btn-hangup").addEventListener("click", () => endCall("You ended the call"));
  $("#btn-restart").addEventListener("click", restart);

  // Check for token in URL hash
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const urlToken = hashParams.get("token") || hashParams.get("room");
  if (urlToken) {
    $("#token-input").value = urlToken;
  }
})();
