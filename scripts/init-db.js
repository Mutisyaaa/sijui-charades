require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const displayName = String(process.env.ADMIN_DISPLAY_NAME || "k3v1n").trim();

if (!process.env.DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL is not set. Skipping database initialization.");
  console.warn("   -> Sijui Charades will run in standalone mode with built-in decks.");
  console.warn("   -> To enable PostgreSQL, set DATABASE_URL in a .env file.");
  process.exit(0);
}

if (!email || !password || !displayName) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_DISPLAY_NAME are required.");
  } else {
    console.warn("⚠️  Admin credentials not set (ADMIN_EMAIL, ADMIN_PASSWORD); skipping admin account seeding.");
    process.exit(0);
  }
}

if (password.length < 8 || password.length > 128) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_PASSWORD must be between 8 and 128 characters.");
  } else {
    console.warn("⚠️  ADMIN_PASSWORD must be between 8 and 128 characters; skipping admin account seeding.");
    process.exit(0);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.NODE_ENV === "production"
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
});

const DEFAULT_DECKS = [
  {
    name: "Chakula",
    description: "Food and drink",
    icon: "🍲",
    theme: "sunset",
    category: "Food and drink",
    cards: [
      "Ugali", "Sukuma wiki", "Nyama choma", "Chapati", "Mandazi", "Githeri",
      "Pilau", "Mutura", "Samosa", "Kachumbari", "Irio", "Mukimo", "Mursik",
      "Smokie na kachumbari", "Chai ya tangawizi", "Mahindi choma", "Uji",
      "Mahamri", "Viazi karai", "Ugali na fish", "Matoke",
    ],
  },
  {
    name: "Usafiri",
    description: "Getting around",
    icon: "🚌",
    theme: "mint",
    category: "Transport",
    cards: [
      "Matatu", "Boda boda", "Tuk tuk", "Nganya", "Makanga", "Bus stage",
      "Madaraka Express", "Nairobi Expressway", "Thika Road traffic",
      "Kenya Airways", "Bolt ride", "Likoni Ferry", "JKIA", "Pikipiki",
      "Squeezed into a full matatu", "Window seat", "Lorry", "Traffic police",
    ],
  },
  {
    name: "Sheng",
    description: "Slang and street talk",
    icon: "🗣️",
    theme: "berry",
    category: "Sheng",
    cards: [
      "Msee", "Manzi", "Ganji", "Chapaa", "Mbogi", "Mtaa", "Kejani", "Buda",
      "Fiti", "Poa", "Sherehe", "Kuchill", "Niaje", "Wueh!", "Aki wewe!",
      "Kubonga", "Jobless corner", "Mtoi", "Kuna form?", "Mambo vipi",
    ],
  },
  {
    name: "Maisha",
    description: "Everyday Kenyan life",
    icon: "🌍",
    theme: "classic",
    category: "Everyday life",
    cards: [
      "M-Pesa", "Power blackout", "Mama mboga", "Mitumba shopping",
      "Chama meeting", "Harambee", "Rain in Nairobi traffic", "Going to shags",
      "Kiosk", "Buying airtime", "Ruracio", "Sunday service",
      "Premier League at the local", "Bargaining at Gikomba", "Side hustle",
      "Kanga", "Kikoi", "Jiko", "Tea break", "Fuel price hike",
    ],
  },
  {
    name: "Kenya",
    description: "Places and pride",
    icon: "🇰🇪",
    theme: "sunset",
    category: "Kenya",
    cards: [
      "Maasai Mara", "Mount Kenya", "Diani Beach", "Lamu", "Fort Jesus",
      "Great Rift Valley", "Hell's Gate", "Lake Nakuru", "KICC", "Uhuru Park",
      "Karura Forest", "Nairobi National Park", "Safaricom", "Tusker",
      "Harambee Stars", "Eliud Kipchoge", "Nyayo Stadium", "Kisumu", "Mombasa",
      "Wildebeest crossing", "Lake Turkana",
    ],
  },
];

async function seedDefaultContent(client, adminUserId) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.content_seeds (
      seed_key text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const seedKey = "default-decks-v1";
  const alreadySeeded = await client.query(
    "SELECT 1 FROM public.content_seeds WHERE seed_key = $1",
    [seedKey],
  );
  if (alreadySeeded.rows[0]) return;

  for (const deckData of DEFAULT_DECKS) {
    const existingDeck = await client.query(
      "SELECT id FROM public.decks WHERE lower(name) = lower($1) LIMIT 1",
      [deckData.name],
    );
    let deckId = existingDeck.rows[0]?.id;

    if (!deckId) {
      const deckResult = await client.query(
        `INSERT INTO public.decks (name, description, icon, theme, is_published, created_by)
         VALUES ($1, $2, $3, $4, true, $5)
         RETURNING id`,
        [deckData.name, deckData.description, deckData.icon, deckData.theme, adminUserId],
      );
      deckId = deckResult.rows[0].id;
    }

    const cardCount = await client.query(
      "SELECT count(*)::int AS count FROM public.cards WHERE deck_id = $1",
      [deckId],
    );
    if (cardCount.rows[0].count === 0) {
      for (const [sortOrder, text] of deckData.cards.entries()) {
        await client.query(
          `INSERT INTO public.cards (deck_id, text, category, difficulty, sort_order, created_by)
           VALUES ($1, $2, $3, 'medium', $4, $5)`,
          [deckId, text, deckData.category, sortOrder, adminUserId],
        );
      }
    }
  }

  await client.query("INSERT INTO public.content_seeds (seed_key) VALUES ($1)", [seedKey]);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const schema = fs.readFileSync(
      path.join(__dirname, "..", "database.render.sql"),
      "utf8",
    );
    await client.query(schema);

    const passwordHash = await bcrypt.hash(password, 12);
    const existing = await client.query(
      "SELECT id FROM public.users WHERE lower(email) = $1",
      [email],
    );

    let adminUserId;

    if (existing.rows[0]) {
      adminUserId = existing.rows[0].id;
      await client.query(
        `UPDATE public.users
         SET display_name = $1, password_hash = $2, role = 'admin', updated_at = now()
         WHERE id = $3`,
        [displayName, passwordHash, existing.rows[0].id],
      );
    } else {
      const inserted = await client.query(
        `INSERT INTO public.users (display_name, email, password_hash, role)
         VALUES ($1, $2, $3, 'admin')
         RETURNING id`,
        [displayName, email, passwordHash],
      );
      adminUserId = inserted.rows[0].id;
    }

    await seedDefaultContent(client, adminUserId);

    await client.query("COMMIT");
    console.log("Database schema, default decks/cards, and the admin account are ready.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("❌ Database initialization error:", error.message);
  if (process.env.NODE_ENV === "production") {
    process.exitCode = 1;
  } else {
    console.warn("⚠️  Continuing in standalone mode. Built-in decks will be used.");
  }
});
