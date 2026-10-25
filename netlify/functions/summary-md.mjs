// 夢のノートの「整理の控え」の窓口。
// ページで整理した結果（Markdown）を受け取って、GitHub のリポジトリに summary.md として上書きで置く。
// 前回と中身が同じなら書かない。整理した日時は、ここで先頭に足す。
// 呼べるのは、環境変数 DREAM_KEY と同じ「あいことば」を送ってきた端末だけ。
// 置き場所は夢の控え（dreams.md）と同じリポジトリ。ファイル名は環境変数 GITHUB_SUMMARY_PATH で変えられる。

import { getStore } from "@netlify/blobs";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-dream-key",
  "access-control-allow-methods": "POST, OPTIONS",
};

const GH_REPO = process.env.GITHUB_REPO || "hirominemoto/dream-note-private";
const GH_PATH = process.env.GITHUB_SUMMARY_PATH || "summary.md";
const MAX_CHARS = 500000;

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

async function hashOf(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(buf).toString("hex");
}

function stampJST() {
  return new Date().toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== "POST") return reply({ error: "使えない呼び方です" }, 405);

  const secret = process.env.DREAM_KEY;
  if (!secret) return reply({ error: "DREAM_KEY がまだ設定されていません" }, 500);
  if (req.headers.get("x-dream-key") !== encodeURIComponent(secret)) return reply({ error: "あいことばが違います" }, 401);

  const token = process.env.GITHUB_TOKEN;
  if (!token) return reply({ github: "off" });

  let body;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "中身が読めませんでした" }, 400);
  }
  const md = typeof body.markdown === "string" ? body.markdown : "";
  if (!md.trim()) return reply({ error: "整理の中身が空でした" }, 400);
  if (md.length > MAX_CHARS) return reply({ error: "整理の中身が長すぎました" }, 413);

  // 中身（日時を除いたもの）が前回と同じなら、書き込まない
  const store = getStore({ name: "dream-note", consistency: "strong" });
  const hash = await hashOf(md);
  if ((await store.get("summary-hash")) === hash) return reply({ github: "same" });

  const content = "# 夢のノート 記録から整理したこと\n\n整理した日時：" + stampJST() + "\n\n" + md.trim() + "\n";
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURI(GH_PATH)}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dream-note",
  };
  for (let tries = 0; tries < 2; tries++) {
    const cur = await fetch(url, { headers });
    let sha;
    if (cur.ok) sha = (await cur.json()).sha;
    else if (cur.status !== 404) {
      console.log("GitHub read failed", cur.status, await cur.text());
      return reply({ github: "error" });
    }
    const put = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        message: "夢の整理を更新",
        content: Buffer.from(content, "utf-8").toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    });
    if (put.ok) {
      await store.set("summary-hash", hash);
      return reply({ github: "saved" });
    }
    if (put.status !== 409 && put.status !== 422) {
      console.log("GitHub write failed", put.status, await put.text());
      return reply({ github: "error" });
    }
  }
  return reply({ github: "error" });
};

export const config = { path: "/api/summary-md" };
