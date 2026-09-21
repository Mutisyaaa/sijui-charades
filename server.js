require("dotenv").config();

const crypto = require("node:crypto");
const express = require("express");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionDays = 7;

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.PGHOST || "localhost",
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || "sijui_charades",
      user: process.env.PGUSER || "postgres",
      password: process.env.PGPASSWORD,
    };

if (process.env.NODE_ENV === "production") {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false }));

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  return Object.fromEntries(header.split(";").filter(Boolean).map(part => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `sijui_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${sessionDays * 86400}${secure}`
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    "Set-Cookie",
    "sijui_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
  );
}

async function startSession(userId, response) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + sessionDays * 86400000);
  await pool.query(
    `INSERT INTO public.sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [tokenHash, userId, expiresAt]
  );
  setSessionCookie(response, token);
}

async function currentUser(request) {
  const token = parseCookies(request).sijui_session;
  if (!token) return null;

  const result = await pool.query(
    `SELECT u.id, u.display_name, u.email, u.role
     FROM public.sessions s
     JOIN public.users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashSessionToken(token)]
  );
  return result.rows[0] || null;
}

async function requireAuth(request, response, next) {
  try {
    const user = await currentUser(request);
    if (!user) return response.status(401).json({ error: "Not signed in." });
    request.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function requireAdmin(request, response, next) {
  await requireAuth(request, response, () => {
    if (request.user.role !== "admin") {
      return response.status(403).json({ error: "Admin access is required." });
    }
    return next();
  });
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 128;
}

app.get("/api/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ ok: true });
  } catch (error) {
    response.status(503).json({ ok: false, error: "Database unavailable" });
  }
});

app.post("/api/signup", async (request, response) => {
  const displayName = String(request.body.displayName || "").trim();
  const email = normaliseEmail(request.body.email);
  const password = request.body.password;

  if (!displayName || displayName.length > 80) {
    return response.status(400).json({ error: "Enter a name up to 80 characters." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return response.status(400).json({ error: "Enter a valid email address." });
  }
  if (!validPassword(password)) {
    return response.status(400).json({ error: "Password must be between 8 and 128 characters." });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query(
      `INSERT INTO public.users (display_name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, display_name, email, role`,
      [displayName, email, passwordHash]
    );
    const user = userResult.rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    await client.query(
      `INSERT INTO public.sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 day'))`,
      [hashSessionToken(token), user.id, sessionDays]
    );
    await client.query("COMMIT");
    setSessionCookie(response, token);
    return response.status(201).json({ user });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return response.status(409).json({ error: "An account with that email already exists." });
    }
    console.error(error);
    return response.status(500).json({ error: "Could not create the account." });
  } finally {
    client.release();
  }
});

app.post("/api/login", async (request, response) => {
  const email = normaliseEmail(request.body.email);
  const password = request.body.password;

  if (!email || typeof password !== "string") {
    return response.status(400).json({ error: "Email and password are required." });
  }

  const result = await pool.query(
    `SELECT id, display_name, email, role, password_hash
     FROM public.users WHERE lower(email) = $1`,
    [email]
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return response.status(401).json({ error: "Email or password is incorrect." });
  }

  await startSession(user.id, response);
  delete user.password_hash;
  return response.json({ user });
});

app.get("/api/me", async (request, response) => {
  const user = await currentUser(request);
  if (!user) return response.status(401).json({ error: "Not signed in." });
  response.json({ user });
});

app.post("/api/logout", async (request, response) => {
  const token = parseCookies(request).sijui_session;
  if (token) {
    await pool.query("DELETE FROM public.sessions WHERE token_hash = $1", [hashSessionToken(token)]);
  }
  clearSessionCookie(response);
  response.status(204).end();
});

app.get("/api/admin/decks", requireAdmin, async (_request, response) => {
  const deckResult = await pool.query(
    `SELECT id, name, description, is_published, created_by, created_at, updated_at
     FROM public.decks ORDER BY name ASC`
  );
  const decks = deckResult.rows;
  if (!decks.length) return response.json([]);

  const cardResult = await pool.query(
    `SELECT id, deck_id, text, sort_order, is_active, created_at, updated_at
     FROM public.cards
     WHERE deck_id = ANY($1::uuid[])
     ORDER BY deck_id, sort_order ASC, created_at ASC`,
    [decks.map(deck => deck.id)]
  );
  const cardsByDeck = new Map(decks.map(deck => [deck.id, []]));
  cardResult.rows.forEach(card => cardsByDeck.get(card.deck_id).push(card));
  response.json(decks.map(deck => ({ ...deck, cards: cardsByDeck.get(deck.id) })));
});

app.post("/api/admin/decks", requireAdmin, async (request, response) => {
  const name = String(request.body.name || "").trim();
  const description = String(request.body.description || "").trim() || null;
  const isPublished = request.body.isPublished !== false;
  if (!name || name.length > 100) {
    return response.status(400).json({ error: "Deck name is required and must be under 100 characters." });
  }

  const result = await pool.query(
    `INSERT INTO public.decks (name, description, is_published, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, description, is_published, created_by, created_at, updated_at`,
    [name, description, isPublished, request.user.id]
  );
  response.status(201).json(result.rows[0]);
});

app.patch("/api/admin/decks/:deckId", requireAdmin, async (request, response) => {
  const name = String(request.body.name || "").trim();
  const description = String(request.body.description || "").trim() || null;
  const isPublished = request.body.isPublished !== false;
  if (!name || name.length > 100) {
    return response.status(400).json({ error: "Deck name is required and must be under 100 characters." });
  }

  const result = await pool.query(
    `UPDATE public.decks
     SET name = $1, description = $2, is_published = $3
     WHERE id = $4
     RETURNING id, name, description, is_published, created_by, created_at, updated_at`,
    [name, description, isPublished, request.params.deckId]
  );
  if (!result.rows[0]) return response.status(404).json({ error: "Deck not found." });
  response.json(result.rows[0]);
});

app.delete("/api/admin/decks/:deckId", requireAdmin, async (request, response) => {
  const result = await pool.query("DELETE FROM public.decks WHERE id = $1 RETURNING id", [request.params.deckId]);
  if (!result.rows[0]) return response.status(404).json({ error: "Deck not found." });
  response.status(204).end();
});

app.post("/api/admin/decks/:deckId/cards", requireAdmin, async (request, response) => {
  const text = String(request.body.text || "").trim();
  const sortOrder = Number.isInteger(Number(request.body.sortOrder)) ? Number(request.body.sortOrder) : 0;
  const isActive = request.body.isActive !== false;
  if (!text || text.length > 160) {
    return response.status(400).json({ error: "Card text is required and must be under 160 characters." });
  }

  const result = await pool.query(
    `INSERT INTO public.cards (deck_id, text, sort_order, is_active, created_by)
     SELECT $1, $2, $3, $4, $5
     WHERE EXISTS (SELECT 1 FROM public.decks WHERE id = $1)
     RETURNING id, deck_id, text, sort_order, is_active, created_at, updated_at`,
    [request.params.deckId, text, sortOrder, isActive, request.user.id]
  );
  if (!result.rows[0]) return response.status(404).json({ error: "Deck not found." });
  response.status(201).json(result.rows[0]);
});

app.patch("/api/admin/cards/:cardId", requireAdmin, async (request, response) => {
  const text = String(request.body.text || "").trim();
  const sortOrder = Number.isInteger(Number(request.body.sortOrder)) ? Number(request.body.sortOrder) : 0;
  const isActive = request.body.isActive !== false;
  if (!text || text.length > 160) {
    return response.status(400).json({ error: "Card text is required and must be under 160 characters." });
  }

  const result = await pool.query(
    `UPDATE public.cards
     SET text = $1, sort_order = $2, is_active = $3
     WHERE id = $4
     RETURNING id, deck_id, text, sort_order, is_active, created_at, updated_at`,
    [text, sortOrder, isActive, request.params.cardId]
  );
  if (!result.rows[0]) return response.status(404).json({ error: "Card not found." });
  response.json(result.rows[0]);
});

app.delete("/api/admin/cards/:cardId", requireAdmin, async (request, response) => {
  const result = await pool.query("DELETE FROM public.cards WHERE id = $1 RETURNING id", [request.params.cardId]);
  if (!result.rows[0]) return response.status(404).json({ error: "Card not found." });
  response.status(204).end();
});

app.get("/", (_request, response) => {
  response.sendFile(path.join(__dirname, "Index.html"));
});

app.use(express.static(path.join(__dirname)));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: "Unexpected server error." });
});

app.listen(port, () => {
  console.log(`Sijui Charades running at http://localhost:${port}`);
});

