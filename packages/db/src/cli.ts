import { migrate } from "./index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const applied = await migrate(url);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
