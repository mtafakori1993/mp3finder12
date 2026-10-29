// Must be the first import in server.js. ES module imports execute before
// the importing file's own top-level code, so calling dotenv.config() inside
// server.js itself would run too late for other modules that read
// process.env.* at their own top level (openrouterService, pageFetcher,
// audioValidator, audioResolver). Importing this file first guarantees the
// environment is populated before any of those modules load.
import dotenv from "dotenv";

dotenv.config();
