/* ============================================================
   Nani Huyu? (Who Am I? Sticky Phone Image Game) Client
   ============================================================ */

const naniState = {
  roomCode: null,
  playerId: null,
  isHost: false,
  deckId: "kenya",
  pollInterval: null,
  room: null,
  lastStatus: null,
  countdownTimer: null,
  availableDecks: []
};

// Helper: safe element getter
const $n = id => document.getElementById(id);

// Load available character decks
async function loadNaniDecks() {
  try {
    const res = await fetch("/api/nani/decks");
    if (!res.ok) throw new Error("Could not load decks");
    const decks = await res.json();
    naniState.availableDecks = decks;
    renderNaniDeckSelector(decks);
  } catch (err) {
    console.warn("Using fallback Nani decks:", err);
  }
}

// Render deck selector cards in Host screen
function renderNaniDeckSelector(decks) {
  const container = $n("naniDeckList");
  if (!container) return;

  if (!decks || !decks.length) {
    container.innerHTML = `
      <div class="empty" style="grid-column: 1 / -1; padding: 24px; text-align: center; border: var(--bw) dashed var(--ink); border-radius: 18px; background: var(--paper-2);">
        <p style="font-weight: 800; font-size: 1.15rem; margin-bottom: 6px;">📸 No character packs yet!</p>
        <p style="opacity: 0.8; font-size: 0.92rem; margin: 0;">Upload your own pictures in the Admin Studio, and your custom packs will appear here.</p>
      </div>
    `;
    return;
  }

  // Ensure selected deck is valid
  if (!decks.some(d => d.id === naniState.deckId)) {
    naniState.deckId = decks[0].id;
  }

  container.innerHTML = decks.map((deck, idx) => `
    <div class="nani-deck-option ${deck.id === naniState.deckId ? 'selected' : ''}" data-deck-id="${deck.id}" role="radio" aria-checked="${deck.id === naniState.deckId}">
      <span class="nani-deck-opt-icon">${deck.icon}</span>
      <div class="nani-deck-opt-info">
        <strong>${escapeHtml(deck.name)}</strong>
        <small>${escapeHtml(deck.description)} · ${deck.count} characters</small>
      </div>
      <span class="nani-deck-opt-check" aria-hidden="true">✓</span>
    </div>
  `).join("");

  container.querySelectorAll(".nani-deck-option").forEach(card => {
    card.addEventListener("click", () => {
      container.querySelectorAll(".nani-deck-option").forEach(c => c.classList.remove("selected"));
      card.classList.add("selected");
      naniState.deckId = card.dataset.deckId;
    });
  });
}

// Create a new room as host
async function createNaniRoom() {
  const hostName = ($n("naniHostNameInput")?.value || "").trim() || "Host";
  const deckId = naniState.deckId || "kenya";
  const createBtn = $n("naniCreateRoomBtn");

  if (createBtn) createBtn.disabled = true;

  try {
    initAudio();
    const res = await fetch("/api/nani/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostName, deckId })
    });

    if (!res.ok) throw new Error("Could not create room");
    const data = await res.json();

    naniState.roomCode = data.roomCode;
    naniState.playerId = data.playerId;
    naniState.isHost = true;
    naniState.room = data.room;

    store.set("naniPlayerName", hostName);
    store.set("naniLastRoom", data.roomCode);

    show("naniLobby", { replace: true });
    handleNaniRoomUpdate(data.room);
    startNaniPolling();
  } catch (err) {
    alert("Error creating room: " + err.message);
  } finally {
    if (createBtn) createBtn.disabled = false;
  }
}

// Join an existing room
async function joinNaniRoom() {
  const playerName = ($n("naniJoinNameInput")?.value || "").trim();
  const roomCode = ($n("naniJoinCodeInput")?.value || "").trim().toUpperCase();
  const errorEl = $n("naniJoinError");
  const joinBtn = $n("naniSubmitJoinBtn");

  if (!playerName) {
    if (errorEl) { errorEl.textContent = "Please enter your name."; errorEl.hidden = false; }
    return;
  }
  if (!roomCode || roomCode.length < 4) {
    if (errorEl) { errorEl.textContent = "Please enter the 4-letter room code."; errorEl.hidden = false; }
    return;
  }

  if (errorEl) errorEl.hidden = true;
  if (joinBtn) joinBtn.disabled = true;

  try {
    initAudio();
    const res = await fetch(`/api/nani/rooms/${encodeURIComponent(roomCode)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerName })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Could not join room");
    }

    naniState.roomCode = data.roomCode;
    naniState.playerId = data.playerId;
    naniState.isHost = Boolean(data.room.isHost);
    naniState.room = data.room;

    store.set("naniPlayerName", playerName);
    store.set("naniLastRoom", data.roomCode);

    show("naniLobby", { replace: true });
    handleNaniRoomUpdate(data.room);
    startNaniPolling();
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  } finally {
    if (joinBtn) joinBtn.disabled = false;
  }
}

// Polling controller
function startNaniPolling() {
  stopNaniPolling();
  pollNaniRoom();
  naniState.pollInterval = setInterval(pollNaniRoom, 1000);
}

function stopNaniPolling() {
  if (naniState.pollInterval) {
    clearInterval(naniState.pollInterval);
    naniState.pollInterval = null;
  }
}

async function pollNaniRoom() {
  if (!naniState.roomCode || !naniState.playerId) return;
  try {
    const res = await fetch(`/api/nani/rooms/${naniState.roomCode}?playerId=${naniState.playerId}`);
    if (res.status === 404) {
      stopNaniPolling();
      alert("Room was closed or expired.");
      show("naniHome", { replace: true });
      return;
    }
    if (!res.ok) return;
    const room = await res.json();
    naniState.room = room;
    handleNaniRoomUpdate(room);
  } catch (err) {
    // transient network error, keep polling
  }
}

// Handle room updates and screen transitions
function handleNaniRoomUpdate(room) {
  const currentStatus = room.status;
  const previousStatus = naniState.lastStatus;
  naniState.lastStatus = currentStatus;

  // Update lobby UI if in lobby
  if (currentStatus === "lobby") {
    renderLobby(room);
    if (!$n("naniLobby")?.classList.contains("active")) {
      show("naniLobby", { replace: true });
    }
    return;
  }

  // Countdown status
  if (currentStatus === "countdown") {
    if (previousStatus !== "countdown") {
      startNaniCountdown(room.countdownEndsAt);
    }
    return;
  }

  // Active playing status
  if (currentStatus === "playing") {
    clearInterval(naniState.countdownTimer);
    naniState.countdownTimer = null;

    const myPlayer = room.players.find(p => p.id === naniState.playerId);
    if (myPlayer && myPlayer.guessed) {
      // Player already guessed, show revealed / waiting screen
      renderNaniRevealed(myPlayer, room);
      if (!$n("naniRevealed")?.classList.contains("active")) {
        show("naniRevealed", { replace: true });
      }
    } else {
      // Player is still guessing - show their character card facing outward
      renderNaniPlay(myPlayer, room);
      if (!$n("naniPlay")?.classList.contains("active")) {
        show("naniPlay", { replace: true });
        requestWake();
      }
    }
    return;
  }

  // Ended / Leaderboard status
  if (currentStatus === "ended") {
    clearInterval(naniState.countdownTimer);
    naniState.countdownTimer = null;
    releaseWake();
    renderNaniLeaderboard(room);
    if (!$n("naniLeaderboard")?.classList.contains("active")) {
      show("naniLeaderboard", { replace: true });
      celebrate();
      playEndSound(10);
    }
  }
}

// Render Lobby Screen
function renderLobby(room) {
  if ($n("naniLobbyCodeText")) $n("naniLobbyCodeText").textContent = room.code;
  if ($n("naniLobbyRoleBadge")) $n("naniLobbyRoleBadge").textContent = room.isHost ? "👑 Host" : "Player";
  if ($n("naniLobbyDeckName")) $n("naniLobbyDeckName").textContent = room.deckName;
  if ($n("naniRosterCount")) $n("naniRosterCount").textContent = room.players.length;

  const deck = naniState.availableDecks.find(d => d.id === room.deckId);
  if ($n("naniLobbyDeckIcon") && deck) $n("naniLobbyDeckIcon").textContent = deck.icon;
  if ($n("naniLobbyDeckDesc") && deck) $n("naniLobbyDeckDesc").textContent = deck.description;

  // Render player roster
  const list = $n("naniRosterList");
  if (list) {
    list.innerHTML = room.players.map(p => `
      <div class="nani-roster-pill ${p.id === naniState.playerId ? 'is-me' : ''}">
        <span class="nani-roster-avatar">${p.isHost ? '👑' : '👤'}</span>
        <span class="nani-roster-name">${escapeHtml(p.name)}</span>
        ${p.id === naniState.playerId ? '<span class="nani-me-tag">YOU</span>' : ''}
      </div>
    `).join("");
  }

  // Host vs Guest controls
  const hostControls = $n("naniHostControls");
  const guestNotice = $n("naniGuestNotice");
  if (hostControls && guestNotice) {
    if (room.isHost) {
      hostControls.style.display = "flex";
      guestNotice.style.display = "none";
    } else {
      hostControls.style.display = "none";
      guestNotice.style.display = "flex";
    }
  }
}

// 5-Second Countdown
function startNaniCountdown(countdownEndsAt) {
  show("naniCountdown", { replace: true });
  initAudio();
  playCountdownSound();
  vibe(60);

  const numEl = $n("naniCountdownNum");
  clearInterval(naniState.countdownTimer);

  const update = () => {
    const leftMs = Math.max(0, countdownEndsAt - Date.now());
    const secs = Math.ceil(leftMs / 1000);

    if (numEl) {
      numEl.textContent = secs > 0 ? secs : "GO!";
      numEl.classList.remove("pop");
      void numEl.offsetWidth;
      numEl.classList.add("pop");
    }

    if (secs > 0) {
      playCountdownSound();
      vibe(30);
    }

    if (leftMs <= 0) {
      clearInterval(naniState.countdownTimer);
      naniState.countdownTimer = null;
      // Trigger a poll to get updated status
      pollNaniRoom();
    }
  };

  update();
  naniState.countdownTimer = setInterval(update, 1000);
}

// Render Main Playing Screen (held straight, facing outward to friends)
function renderNaniPlay(myPlayer, room) {
  const card = myPlayer ? myPlayer.card : null;
  if (!card) return;

  const guessedCount = room.players.filter(p => p.guessed).length;
  const totalCount = room.players.length;
  if ($n("naniPlayRosterProgress")) {
    $n("naniPlayRosterProgress").textContent = `${guessedCount} / ${totalCount} Guessed`;
  }

  // Populate card image only (no name/category/hint to keep the pressure on other players!)
  const imgEl = $n("naniCardImage");
  const fallbackEl = $n("naniCardAvatarFallback");

  if (imgEl && fallbackEl) {
    imgEl.style.display = "block";
    fallbackEl.style.display = "none";
    imgEl.onerror = () => {
      imgEl.style.display = "none";
      fallbackEl.style.display = "flex";
    };
    imgEl.src = card.image || "";
  }
}

// Player taps "I Guessed It!"
async function submitNaniGuess() {
  if (!naniState.roomCode || !naniState.playerId) return;
  const btn = $n("naniGuessBtn");
  if (btn) btn.disabled = true;

  try {
    initAudio();
    playRightSound();
    vibe([60, 40, 80]);

    const res = await fetch(`/api/nani/rooms/${naniState.roomCode}/guess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: naniState.playerId })
    });

    if (!res.ok) throw new Error("Could not submit guess");
    const room = await res.json();
    naniState.room = room;
    handleNaniRoomUpdate(room);
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Render Revealed Screen (after player has guessed their card)
function renderNaniRevealed(myPlayer, room) {
  const card = myPlayer ? myPlayer.card : null;
  if (!card) return;

  const rank = myPlayer.rank;
  const rankText = rank === "last"
    ? "🐢 Last Place"
    : (rank === 1 ? "🥇 1st Place!" : (rank === 2 ? "🥈 2nd Place!" : (rank === 3 ? "🥉 3rd Place!" : `#${rank} Place!`)));

  const badgeEl = $n("naniRevealedRankBadge");
  if (badgeEl) {
    badgeEl.textContent = rankText;
    badgeEl.className = "nani-revealed-badge " + (rank === 1 ? "gold" : (rank === "last" ? "last" : ""));
  }

  if ($n("naniRevealedName")) $n("naniRevealedName").textContent = card.name;
  if ($n("naniRevealedCat")) $n("naniRevealedCat").textContent = card.category;
  if ($n("naniRevealedHint")) $n("naniRevealedHint").textContent = card.hint || "";

  const thumb = $n("naniRevealedImg");
  if (thumb) {
    thumb.src = card.image || "";
    thumb.onerror = () => { thumb.style.display = "none"; };
  }

  // Live status of other players
  const liveContainer = $n("naniRevealedLiveRoster");
  if (liveContainer) {
    liveContainer.innerHTML = room.players.map(p => {
      const isGuessed = p.guessed;
      const rankBadge = p.rank === 1 ? '🥇' : (p.rank === 2 ? '🥈' : (p.rank === 3 ? '🥉' : (p.rank ? `#${p.rank}` : '⌛')));
      return `
        <div class="nani-live-pill ${isGuessed ? 'is-done' : 'is-playing'}">
          <span>${rankBadge} ${escapeHtml(p.name)}</span>
          <small>${isGuessed ? 'Done!' : 'Still asking questions…'}</small>
        </div>
      `;
    }).join("");
  }
}

// Render Final Leaderboard
function renderNaniLeaderboard(room) {
  const sorted = [...room.players].sort((a, b) => {
    if (a.rank === "last") return 1;
    if (b.rank === "last") return -1;
    return (a.rank || 99) - (b.rank || 99);
  });

  const podiumEl = $n("naniPodiumContainer");
  const listEl = $n("naniRankingsList");

  // Top 3 Podiums
  if (podiumEl) {
    const top3 = sorted.slice(0, 3);
    const podiumIcons = ["🥇", "🥈", "🥉"];
    podiumEl.innerHTML = top3.map((p, i) => {
      const card = p.card || {};
      return `
        <div class="nani-podium-card rank-${i + 1}">
          <span class="podium-medal">${podiumIcons[i]}</span>
          <strong>${escapeHtml(p.name)}</strong>
          <span class="podium-char">${escapeHtml(card.name || "Unknown")}</span>
          <small class="podium-cat">${escapeHtml(card.category || "")}</small>
        </div>
      `;
    }).join("");
  }

  // Full rankings with Last place banter
  if (listEl) {
    listEl.innerHTML = sorted.map((p, i) => {
      const card = p.card || {};
      const isLast = p.rank === "last" || (i === sorted.length - 1 && sorted.length > 1);
      const rankPill = isLast ? '🐢 Last Place' : (p.rank ? `#${p.rank}` : `#${i + 1}`);

      return `
        <li class="nani-ranking-row ${isLast ? 'is-last-place' : ''}">
          <div class="nani-ranking-left">
            <span class="nani-ranking-num">${rankPill}</span>
            <div class="nani-ranking-info">
              <strong>${escapeHtml(p.name)}</strong>
              <small>Was: <b>${escapeHtml(card.name || "Unknown")}</b> (${escapeHtml(card.category || "")})</small>
            </div>
          </div>
          ${isLast ? '<span class="nani-banter-pill">“Kwani ulikwama wapi?!” 😂</span>' : '<span>✓</span>'}
        </li>
      `;
    }).join("");
  }

  // Host buttons
  const playAgainBtn = $n("naniPlayAgainBtn");
  if (playAgainBtn) {
    playAgainBtn.style.display = room.isHost ? "block" : "none";
  }
}

// Host restarts next round
async function restartNaniRound() {
  if (!naniState.roomCode || !naniState.playerId) return;
  const btn = $n("naniPlayAgainBtn");
  if (btn) btn.disabled = true;

  try {
    initAudio();
    const res = await fetch(`/api/nani/rooms/${naniState.roomCode}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: naniState.playerId })
    });

    if (!res.ok) throw new Error("Could not restart round");
    const room = await res.json();
    naniState.room = room;
    handleNaniRoomUpdate(room);
  } catch (err) {
    alert("Error restarting round: " + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Leave room
async function leaveNaniRoom(targetScreen = "naniHome") {
  if (naniState.roomCode && naniState.playerId) {
    try {
      fetch(`/api/nani/rooms/${naniState.roomCode}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId: naniState.playerId })
      });
    } catch (e) {}
  }
  stopNaniPolling();
  naniState.roomCode = null;
  naniState.playerId = null;
  naniState.room = null;
  if (targetScreen) {
    if (typeof navigateBack === "function" && targetScreen === "naniHome" && typeof navDepth !== "undefined" && navDepth > 0) {
      navigateBack("naniHome");
    } else {
      show(targetScreen, { replace: true });
    }
  }
}

/* ============================================================
   Event Listeners & Wiring
   ============================================================ */
function initNaniClient() {
  // Home button to open Nani Huyu
  $n("naniHuyuBtn")?.addEventListener("click", () => {
    loadNaniDecks();
    show("naniHome");
  });

  // Nani Home navigation
  $n("naniHomeBack")?.addEventListener("click", () => {
    if (typeof navigateBack === "function") navigateBack("home");
    else show("home");
  });
  $n("naniGoHostBtn")?.addEventListener("click", () => {
    const savedName = store.get("naniPlayerName", "");
    if (savedName && $n("naniHostNameInput")) $n("naniHostNameInput").value = savedName;
    show("naniHost");
  });
  $n("naniGoJoinBtn")?.addEventListener("click", () => {
    const savedName = store.get("naniPlayerName", "");
    if (savedName && $n("naniJoinNameInput")) $n("naniJoinNameInput").value = savedName;
    const err = $n("naniJoinError");
    if (err) err.hidden = true;
    show("naniJoin");
  });

  // Host setup
  $n("naniHostBack")?.addEventListener("click", () => {
    if (typeof navigateBack === "function") navigateBack("naniHome");
    else show("naniHome");
  });
  $n("naniCreateRoomBtn")?.addEventListener("click", createNaniRoom);

  // Join screen
  $n("naniJoinBack")?.addEventListener("click", () => {
    if (typeof navigateBack === "function") navigateBack("naniHome");
    else show("naniHome");
  });
  $n("naniSubmitJoinBtn")?.addEventListener("click", joinNaniRoom);
  $n("naniJoinCodeInput")?.addEventListener("input", e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  $n("naniJoinCodeInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") joinNaniRoom();
  });

  // Lobby
  $n("naniLobbyLeaveBtn")?.addEventListener("click", () => leaveNaniRoom("naniHome"));
  $n("naniCopyCodeBtn")?.addEventListener("click", () => {
    if (!naniState.roomCode) return;
    const shareUrl = `${window.location.origin}/?nani=${naniState.roomCode}`;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareUrl);
        showMoment("📋 Link copied to clipboard!");
      } else {
        prompt("Share this link with friends:", shareUrl);
      }
    } catch (e) {
      prompt("Room code:", naniState.roomCode);
    }
  });

  $n("naniHostStartBtn")?.addEventListener("click", async () => {
    if (!naniState.roomCode || !naniState.playerId) return;
    const btn = $n("naniHostStartBtn");
    if (btn) btn.disabled = true;

    try {
      initAudio();
      const res = await fetch(`/api/nani/rooms/${naniState.roomCode}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId: naniState.playerId })
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Could not start game");
      }
      const room = await res.json();
      naniState.room = room;
      handleNaniRoomUpdate(room);
    } catch (err) {
      alert(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // In-Game Guess Button
  $n("naniGuessBtn")?.addEventListener("click", submitNaniGuess);

  // Leaderboard buttons
  $n("naniPlayAgainBtn")?.addEventListener("click", restartNaniRound);
  $n("naniExitBtn")?.addEventListener("click", () => leaveNaniRoom("naniHome"));

  // Check URL query parameters for auto-join (e.g. ?nani=KUKU)
  try {
    const params = new URLSearchParams(window.location.search);
    const naniCode = params.get("nani") || params.get("room");
    if (naniCode) {
      loadNaniDecks();
      if ($n("naniJoinCodeInput")) $n("naniJoinCodeInput").value = naniCode.toUpperCase();
      const savedName = store.get("naniPlayerName", "");
      if (savedName && $n("naniJoinNameInput")) $n("naniJoinNameInput").value = savedName;
      show("naniJoin");
    }
  } catch (e) {}
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initNaniClient);
} else {
  initNaniClient();
}
