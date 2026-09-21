// Copies non-TS renderer assets (HTML) next to the compiled JS.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(path.join(root, "dist", "renderer"), { recursive: true });
copyFileSync(
  path.join(root, "src", "renderer", "connect.html"),
  path.join(root, "dist", "renderer", "connect.html"),
);
console.log("assets copied");
