import { createDb } from "./client.js";
import { seed } from "./seed-data.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, close } = createDb(url);
const r = await seed(db);
console.log(`seeded campaign ${r.campaign.id}, ${r.contacts.length} contacts, ${r.tasks.length} call_tasks`);
await close();
