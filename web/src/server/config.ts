import { resolve } from "node:path";

export const REPO_DIR = resolve(process.env.REPO_DIR ?? resolve(import.meta.dir, "../../.."));

export const HOST = process.env.HOST ?? "127.0.0.1";
export const PORT = Number(process.env.PORT ?? 3000);

// Host names the browser may use besides localhost. Every request's Host
// header is checked against this list, which is what stops DNS rebinding.
export const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export const UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
export const DOWNLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
