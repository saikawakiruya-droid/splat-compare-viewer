import { defineConfig } from "vite";
import { spawn } from "node:child_process";
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Dev-only endpoint: POST a .ply to /api/register-ply and the server runs
// scripts/add-scene.sh locally (build-lod + ply_to_splat.py) to generate the
// RAD/SPZ/.splat comparison formats and register the scene in public/scenes.json.
// This is what makes "drop a .ply on the page to register it" work — RAD/SPZ
// generation is native (build-lod) and can't run in the browser, so the drop
// uploads the file to this local dev server which does the generation.
// Not present in the built site (`vite build`), so the hosted viewer stays
// view-only.
function registerPlyPlugin() {
  return {
    name: "register-ply",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use("/api/register-ply", async (req, res) => {
        const json = (code, obj) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(obj));
        };
        if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
        try {
          const url = new URL(req.url, "http://localhost");
          const rawName = url.searchParams.get("name") || "";
          const filename = url.searchParams.get("filename") || "dropped.ply";
          const label = url.searchParams.get("label") || rawName || filename.replace(/\.[^.]+$/, "");

          // Sanitize the internal key the same way add-scene.sh would; fall back
          // to scene_<n> when the name has no ascii-safe characters (e.g. a
          // Japanese filename), so the script never rejects an empty name.
          let key = rawName.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_-]/g, "");
          const scenesPath = path.join(root, "public", "scenes.json");
          let existing = { scenes: [] };
          if (existsSync(scenesPath)) existing = JSON.parse(await readFile(scenesPath, "utf8"));
          if (!key) key = `scene_${(existing.scenes || []).length + 1}`;

          // Buffer the uploaded body to a temp .ply.
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const buf = Buffer.concat(chunks);
          if (!buf.length) return json(400, { ok: false, error: "empty upload" });
          const tmpDir = path.join(os.tmpdir(), "viewer-register");
          await mkdir(tmpDir, { recursive: true });
          const tmpPly = path.join(tmpDir, "in.ply");
          await writeFile(tmpPly, buf);

          // Run the same script the CLI uses.
          const script = path.join(root, "scripts", "add-scene.sh");
          const out = await new Promise((resolve, reject) => {
            const p = spawn(script, [tmpPly, key, label], { cwd: root });
            let stdout = "", stderr = "";
            p.stdout.on("data", (d) => (stdout += d));
            p.stderr.on("data", (d) => (stderr += d));
            p.on("error", reject);
            p.on("close", (code) =>
              code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `add-scene.sh exit ${code}`))
            );
          });
          await rm(tmpPly, { force: true });

          const scenes = JSON.parse(await readFile(scenesPath, "utf8"));
          return json(200, { ok: true, key, scenes, log: out.trim() });
        } catch (e) {
          return json(500, { ok: false, error: String((e && e.message) || e) });
        }
      });

      // Update an existing registered scene's orientation and/or saved camera
      // (from the orientation panel's "保存"). Dev-server only.
      server.middlewares.use("/api/update-scene", async (req, res) => {
        const json = (code, obj) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(obj));
        };
        if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          const { key, orient, camera } = body;
          if (!key) return json(400, { ok: false, error: "key required" });
          const scenesPath = path.join(root, "public", "scenes.json");
          if (!existsSync(scenesPath)) return json(404, { ok: false, error: "scenes.json not found" });
          const data = JSON.parse(await readFile(scenesPath, "utf8"));
          const s = (data.scenes || []).find((x) => x.key === key);
          if (!s) return json(404, { ok: false, error: `scene not found: ${key}` });
          if (orient) s.orient = orient;
          if (camera) s.camera = camera;
          await writeFile(scenesPath, JSON.stringify(data, null, 2), "utf8");
          return json(200, { ok: true });
        } catch (e) {
          return json(500, { ok: false, error: String((e && e.message) || e) });
        }
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves this project site under /splat-compare-viewer/, so the
  // hosted build must emit that base prefix (main.js reads it via BASE_URL to
  // prefix asset paths). Local dev stays at "/". Baked in here so a redeploy
  // can't forget the CLI --base flag and ship root-absolute paths that 404.
  base: process.env.VITE_HOSTED ? "/splat-compare-viewer/" : "/",
  // Local dev serves everything from public/ (all scenes).
  // Hosted build (VITE_HOSTED=1) uses public-hosted/ which contains only the
  // small kiruya assets, so GitHub Pages stays under its size limits.
  publicDir: process.env.VITE_HOSTED ? "public-hosted" : "public",
  plugins: [registerPlyPlugin()],
});
