const express = require("express");
const crypto = require("node:crypto");
const https = require("node:https");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const NANI_DECKS = require("./nani-data");

const router = express.Router();
const rooms = new Map();

let dbPool = null;
router.setPool = function(p) {
  dbPool = p;
};

async function fetchCustomCards() {
  if (dbPool) {
    try {
      const res = await dbPool.query(
        "SELECT id, category, name, image_url FROM public.nani_characters ORDER BY created_at DESC"
      );
      if (res && res.rows) {
        return res.rows.map(r => ({
          id: r.id,
          name: r.name || "Character",
          category: r.category || "General",
          hint: "",
          avatar: "📸",
          image: r.image_url
        }));
      }
    } catch (_) {}
  }
  try {
    const fp = path.join(__dirname, "nani-custom-cards.json");
    if (fs.existsSync(fp)) {
      const list = JSON.parse(fs.readFileSync(fp, "utf8"));
      return list.map(r => ({
        id: r.id,
        name: r.name || "Character",
        category: r.category || "General",
        hint: "",
        avatar: "📸",
        image: r.image_url || r.image
      }));
    }
  } catch (_) {}
  return [];
}

// Helper: generate friendly 4-letter room code (avoiding confusing characters)
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return "NANI" + Math.floor(100 + Math.random() * 900);
}

// Helper: shuffle array
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Clean up stale rooms older than 3 hours
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > 3 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

// Helper: get card pool by deck ID (built-in + admin custom uploaded)
async function getDeckCards(deckId) {
  const customCards = await fetchCustomCards();
  const allCards = [...NANI_DECKS.flatMap(d => d.cards || []), ...customCards];

  if (!allCards.length) {
    return [];
  }

  if (!deckId || deckId === "all") {
    return shuffle(allCards);
  }

  // Check if deckId matches built-in deck
  const builtin = NANI_DECKS.find(d => d.id === deckId);
  if (builtin && builtin.cards) {
    const matchingCustom = customCards.filter(c => {
      const cat = (c.category || "").toLowerCase();
      const bName = (builtin.name || "").toLowerCase();
      const bId = (builtin.id || "").toLowerCase();
      return cat.includes(bId) || bName.includes(cat) || cat.includes(bName);
    });
    return [...builtin.cards, ...matchingCustom];
  }

  // Check custom category decks
  const matchingCustom = customCards.filter(c => {
    const slug = "custom_" + (c.category || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return slug === deckId || (c.category || "").toLowerCase() === deckId.toLowerCase();
  });
  if (matchingCustom.length > 0) {
    return matchingCustom;
  }

  return shuffle(allCards);
}

// Helper: auto-advance countdown if 5s has elapsed
function checkRoomCountdown(room) {
  if (room.status === "countdown" && Date.now() >= room.countdownEndsAt) {
    room.status = "playing";
    room.startedAt = Date.now();
  }
}

// Helper: serialize room for a specific viewer
function serializeRoom(room, viewerPlayerId) {
  checkRoomCountdown(room);

  const myPlayer = room.players.find(p => p.id === viewerPlayerId);

  return {
    code: room.code,
    hostId: room.hostId,
    deckId: room.deckId,
    deckName: room.deckId === "all" ? "🎲 Random Mix (All Photos)" : (NANI_DECKS.find(d => d.id === room.deckId) || { name: (room.deckName || room.deckId.replace(/^custom_/, "").replace(/-/g, " ")) || "Nani Huyu?" }).name,
    status: room.status,
    countdownEndsAt: room.countdownEndsAt,
    startedAt: room.startedAt,
    nextRank: room.nextRank,
    isHost: Boolean(myPlayer && myPlayer.isHost),
    myPlayerId: viewerPlayerId || null,
    myCard: myPlayer ? myPlayer.card : null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      guessed: p.guessed,
      rank: p.rank,
      guessedAt: p.guessedAt,
      // Card is sent so the phone can display it outwardly facing friends
      card: p.card
    }))
  };
}

/* ============================================================
   Routes
   ============================================================ */

// 1. Get available Nani Huyu decks (built-in + admin custom)
router.get("/decks", async (_req, res) => {
  const customCards = await fetchCustomCards();
  const allBuiltinCount = NANI_DECKS.reduce((acc, d) => acc + (d.cards ? d.cards.length : 0), 0);
  const totalCount = allBuiltinCount + customCards.length;

  // Group any custom categories that don't match built-in decks
  const customGroupMap = new Map();
  for (const card of customCards) {
    const cat = (card.category || "General").trim();
    if (!customGroupMap.has(cat)) customGroupMap.set(cat, []);
    customGroupMap.get(cat).push(card);
  }

  // Also include any categories from dbPool even if they have 0 cards yet
  if (dbPool) {
    try {
      const catRes = await dbPool.query("SELECT name FROM public.nani_categories");
      if (catRes && catRes.rows) {
        for (const row of catRes.rows) {
          if (!customGroupMap.has(row.name)) customGroupMap.set(row.name, []);
        }
      }
    } catch (_) {}
  }

  const customDecks = [];
  for (const [catName, cards] of customGroupMap.entries()) {
    const isBuiltin = NANI_DECKS.some(d => 
      d.name.toLowerCase().includes(catName.toLowerCase()) || 
      catName.toLowerCase().includes(d.name.toLowerCase()) || 
      d.id === catName.toLowerCase()
    );
    if (!isBuiltin) {
      const slug = "custom_" + catName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      customDecks.push({
        id: slug,
        categoryName: catName,
        name: catName,
        description: cards.length > 0
          ? `${cards.length} character photo${cards.length === 1 ? '' : 's'}`
          : "0 photos (upload in studio)",
        icon: "📸",
        count: cards.length
      });
    }
  }

  const builtinDecks = NANI_DECKS.filter(d => d.cards && d.cards.length > 0).map(d => {
    const extraCount = customCards.filter(c => {
      const cat = (c.category || "").toLowerCase();
      return cat.includes(d.id.toLowerCase()) || d.name.toLowerCase().includes(cat);
    }).length;
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      icon: d.icon,
      count: d.cards.length + extraCount
    };
  });

  const result = [...builtinDecks, ...customDecks];

  // ALWAYS include "🎲 Random Mix (All Photos)" whenever there are pictures in the library!
  if (totalCount > 0) {
    result.unshift({
      id: "all",
      name: "🎲 Random Mix (All Photos)",
      description: `A wild shuffle of all ${totalCount} photos across every category!`,
      icon: "🎲",
      count: totalCount
    });
  }

  res.json(result);
});

// 2. Create room
router.post("/rooms", (req, res) => {
  const hostName = String(req.body.hostName || "Host").trim().slice(0, 30) || "Host";
  const deckId = String(req.body.deckId || "kenya").trim();

  const code = generateRoomCode();
  const hostId = crypto.randomUUID();

  const room = {
    code,
    hostId,
    deckId,
    status: "lobby",
    countdownEndsAt: 0,
    startedAt: 0,
    nextRank: 1,
    players: [
      {
        id: hostId,
        name: hostName,
        isHost: true,
        card: null,
        guessed: false,
        rank: null,
        guessedAt: null,
        lastSeen: Date.now()
      }
    ],
    usedCardIds: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now()
  };

  rooms.set(code, room);
  res.status(201).json({
    roomCode: code,
    playerId: hostId,
    room: serializeRoom(room, hostId)
  });
});

// 3. Join room
router.post("/rooms/:code/join", (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const room = rooms.get(code);

  if (!room) {
    return res.status(404).json({ error: "Room not found. Please check your code." });
  }

  if (room.status !== "lobby" && room.status !== "ended") {
    return res.status(409).json({ error: "A round is already in progress. Wait for it to finish or ask the host." });
  }

  let playerName = String(req.body.playerName || "").trim().slice(0, 30);
  if (!playerName) playerName = `Player ${room.players.length + 1}`;

  // Ensure unique display name within room
  let uniqueName = playerName;
  let counter = 2;
  while (room.players.some(p => p.name.toLowerCase() === uniqueName.toLowerCase())) {
    uniqueName = `${playerName} (${counter++})`;
  }

  const playerId = crypto.randomUUID();
  room.players.push({
    id: playerId,
    name: uniqueName,
    isHost: false,
    card: null,
    guessed: false,
    rank: null,
    guessedAt: null,
    lastSeen: Date.now()
  });

  room.lastActivity = Date.now();

  res.json({
    roomCode: code,
    playerId,
    room: serializeRoom(room, playerId)
  });
});

// 4. Poll room state
router.get("/rooms/:code", (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const playerId = String(req.query.playerId || req.headers["x-player-id"] || "");
  const room = rooms.get(code);

  if (!room) {
    return res.status(404).json({ error: "Room not found or has expired." });
  }

  const player = room.players.find(p => p.id === playerId);
  if (player) player.lastSeen = Date.now();
  room.lastActivity = Date.now();

  res.json(serializeRoom(room, playerId));
});

// 5. Host change deck
router.post("/rooms/:code/deck", (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const playerId = String(req.body.playerId || req.body.hostId || "");
  const deckId = String(req.body.deckId || "kenya").trim();

  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: "Room not found." });
  if (room.hostId !== playerId) return res.status(403).json({ error: "Only the host can change decks." });

  room.deckId = deckId;
  room.lastActivity = Date.now();
  res.json(serializeRoom(room, playerId));
});

// 6. Host starts round (initiates 5-second countdown)
router.post("/rooms/:code/start", async (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const playerId = String(req.body.playerId || req.body.hostId || "");
  const deckId = String(req.body.deckId || "").trim();

  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: "Room not found." });
  if (room.hostId !== playerId) return res.status(403).json({ error: "Only the host can start the game." });

  if (deckId) room.deckId = deckId;

  let pool = await getDeckCards(room.deckId);
  if (!pool || !pool.length) {
    return res.status(400).json({ error: "No character pictures in this deck yet! Please upload photos in the Admin Studio." });
  }

  // If the chosen deck has fewer cards than players in the room,
  // supplement from the full library so no two players EVER get the same character!
  if (pool.length < room.players.length) {
    const allCards = await getDeckCards("all");
    const existingIds = new Set(pool.map(c => c.id || c.image));
    for (const extraCard of shuffle(allCards)) {
      if (!existingIds.has(extraCard.id || extraCard.image)) {
        pool.push(extraCard);
        existingIds.add(extraCard.id || extraCard.image);
      }
      if (pool.length >= room.players.length) break;
    }
    // If still fewer cards than players, expand pool by repeating
    let expanded = [...pool];
    while (expanded.length < room.players.length) {
      expanded = expanded.concat(pool);
    }
    pool = expanded;
  }

  const shuffled = shuffle(pool);

  // Assign a distinct card to each player - guaranteed unique per player
  room.players.forEach((player, idx) => {
    player.card = shuffled[idx];
    player.guessed = false;
    player.rank = null;
    player.guessedAt = null;
  });

  room.nextRank = 1;
  room.status = "countdown";
  // 5 seconds countdown so players turn their phone outward facing friends
  room.countdownEndsAt = Date.now() + 5000;
  room.startedAt = 0;
  room.lastActivity = Date.now();

  res.json(serializeRoom(room, playerId));
});

// 7. Player taps "I Guessed It!"
router.post("/rooms/:code/guess", (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const playerId = String(req.body.playerId || "");

  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: "Room not found." });
  checkRoomCountdown(room);
  if (room.status !== "playing") return res.status(400).json({ error: "Game is not active." });

  const player = room.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: "Player not found." });

  if (!player.guessed) {
    player.guessed = true;
    player.rank = room.nextRank++;
    player.guessedAt = Date.now();
  }

  // Check remaining players
  const unguessed = room.players.filter(p => !p.guessed);
  if (unguessed.length === 1 && room.players.length > 1) {
    // The last remaining person automatically gets Last Place
    const lastPlayer = unguessed[0];
    lastPlayer.guessed = true;
    lastPlayer.rank = "last";
    lastPlayer.guessedAt = Date.now();
    room.status = "ended";
  } else if (unguessed.length === 0) {
    room.status = "ended";
  }

  room.lastActivity = Date.now();
  res.json(serializeRoom(room, playerId));
});

// 8. Host restarts round
router.post("/rooms/:code/restart", async (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const playerId = String(req.body.playerId || req.body.hostId || "");
  const deckId = String(req.body.deckId || "").trim();

  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: "Room not found." });
  if (room.hostId !== playerId) return res.status(403).json({ error: "Only the host can start a new round." });

  if (deckId) room.deckId = deckId;

  let pool = await getDeckCards(room.deckId);
  if (pool.length < room.players.length) {
    const allCards = await getDeckCards("all");
    const existingIds = new Set(pool.map(c => c.id || c.image));
    for (const extraCard of shuffle(allCards)) {
      if (!existingIds.has(extraCard.id || extraCard.image)) {
        pool.push(extraCard);
        existingIds.add(extraCard.id || extraCard.image);
      }
      if (pool.length >= room.players.length) break;
    }
  }

  const shuffled = shuffle(pool);

  room.players.forEach((player, idx) => {
    player.card = shuffled[idx];
    player.guessed = false;
    player.rank = null;
    player.guessedAt = null;
  });

  room.nextRank = 1;
  room.status = "countdown";
  room.countdownEndsAt = Date.now() + 5000;
  room.startedAt = 0;
  room.lastActivity = Date.now();

  res.json(serializeRoom(room, playerId));
});

// 9. Leave room
router.post("/rooms/:code/leave", (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const playerId = String(req.body.playerId || "");

  const room = rooms.get(code);
  if (!room) return res.json({ ok: true });

  room.players = room.players.filter(p => p.id !== playerId);
  if (room.players.length === 0) {
    rooms.delete(code);
    return res.json({ ok: true, deleted: true });
  }

  // If host left, assign host to first remaining player
  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
    room.players[0].isHost = true;
  }

  room.lastActivity = Date.now();
  res.json({ ok: true, room: serializeRoom(room, null) });
});

// 10. Image proxy to guarantee 100% reliable cross-origin loading
router.get("/proxy", (req, res) => {
  const target = req.query.url;
  if (!target || typeof target !== "string") {
    return res.status(400).send("Target url is required");
  }

  try {
    const parsed = new URL(target);
    const client = parsed.protocol === "https:" ? https : http;

    client.get(target, {
      headers: {
        "User-Agent": "SijuiApp/1.0 (https://sijui-game.onrender.com; contact@sijui.app)",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    }, proxyRes => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        return res.redirect(proxyRes.headers.location);
      }
      res.set({
        "Content-Type": proxyRes.headers["content-type"] || "image/jpeg",
        "Cache-Control": "public, max-age=86400"
      });
      proxyRes.pipe(res);
    }).on("error", err => {
      res.status(502).send("Proxy error: " + err.message);
    });
  } catch (err) {
    res.status(400).send("Invalid URL");
  }
});

module.exports = router;
