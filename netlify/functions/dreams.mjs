// 夢のノートの保管庫。PCとスマホが同じノートを見るための窓口。
// 夢そのものは Netlify Blobs に1つのファイル（dreams）として置いておく。
// 読み書きできるのは、環境変数 DREAM_KEY と同じ「あいことば」を送ってきた端末だけ。
// 環境変数 GITHUB_TOKEN があれば、夢が変わるたびに GitHub のリポジトリにも Markdown で控えを置く。

import { getStore } from "@netlify/blobs";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  // 古いGitHub Pages版から引っ越しするときに呼べるように、ほかの場所からの呼び出しも受ける
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-dream-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

// ---- GitHub への控え ----
// 置き場所は環境変数で変えられる。なければ dream-note-private の dreams.md。
const GH_REPO = process.env.GITHUB_REPO || "hirominemoto/dream-note-private";
const GH_PATH = process.env.GITHUB_PATH || "dreams.md";

// 画面の「Markdownで書き出す」と同じ形にそろえる
function markdownText(d) {
  const title = String(d.title || "タイトルなし").replace(/\r?\n/g, " ");
  const lines = ["# " + title, "", "見た日：" + (d.date || "不明")];
  if (d.people) lines.push("登場人物：" + d.people);
  if (Array.isArray(d.tags) && d.tags.length) lines.push("気分：" + d.tags.join("、"));
  lines.push("", "## 夢の内容", "", String(d.body || ""));
  return lines.join("\n");
}

function markdownAll(dreams) {
  const ordered = dreams.slice().sort(
    (a, b) => (a.date || "").localeCompare(b.date || "") || (a.created || 0) - (b.created || 0)
  );
  return "# 夢のノート\n\n全" + ordered.length + "件\n\n---\n\n" +
    ordered.map(markdownText).join("\n\n---\n\n") + "\n";
}

async function hashOf(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(buf).toString("hex");
}

// 前回 GitHub に置いた中身と違うときだけ書き込む。
// 失敗しても夢の保存（同期）は止めない。次の同期でもう一度試す。
async function saveToGitHub(store, dreams) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return "off";
  const md = markdownAll(dreams);
  const hash = await hashOf(md);
  if ((await store.get("github-hash")) === hash) return "same";

  const url = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURI(GH_PATH)}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dream-note",
  };
  for (let tries = 0; tries < 2; tries++) {
    // いまある dreams.md の版（sha）を聞いてから上書きする。まだなければ新しく作る。
    const cur = await fetch(url, { headers });
    let sha;
    if (cur.ok) sha = (await cur.json()).sha;
    else if (cur.status !== 404) {
      console.log("GitHub read failed", cur.status, await cur.text());
      return "error";
    }
    const put = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        message: "夢のノートを更新（" + dreams.length + "件）",
        content: Buffer.from(md, "utf-8").toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    });
    if (put.ok) {
      await store.set("github-hash", hash);
      return "saved";
    }
    // 別の端末とほぼ同時に書いたときは版がずれるので、もう一度だけ試す
    if (put.status !== 409 && put.status !== 422) {
      console.log("GitHub write failed", put.status, await put.text());
      return "error";
    }
  }
  return "error";
}

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  const secret = process.env.DREAM_KEY;
  if (!secret) return reply({ error: "DREAM_KEY がまだ設定されていません" }, 500);
  // 日本語のあいことばも使えるように、送る側でエンコードしてある
  if (req.headers.get("x-dream-key") !== encodeURIComponent(secret)) return reply({ error: "あいことばが違います" }, 401);

  const store = getStore({ name: "dream-note", consistency: "strong" });
  const data = (await store.get("dreams", { type: "json" })) || { dreams: [], deleted: [] };

  if (req.method === "GET") return reply(data);
  if (req.method !== "POST") return reply({ error: "使えない呼び方です" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "中身が読めませんでした" }, 400);
  }

  // 消した夢は「消した印」を残しておく。別の端末が古い控えを送ってきても生き返らないように。
  const deleted = new Set(data.deleted);
  for (const id of Array.isArray(body.delete) ? body.delete : []) {
    if (typeof id === "string") deleted.add(id);
  }

  // 新しく届いた夢を足す。同じ id がもうあれば、あとから書き直されたほうを残す
  // （書き直していない夢は updated を持たないので、書いた時刻で比べる）
  const stamp = (d) => Number(d.updated || d.created) || 0;
  const byId = new Map(data.dreams.map((d) => [d.id, d]));
  for (const d of Array.isArray(body.upsert) ? body.upsert : []) {
    if (!d || typeof d.id !== "string" || typeof d.body !== "string") continue;
    const cur = byId.get(d.id);
    if (!cur || stamp(d) > stamp(cur)) byId.set(d.id, d);
  }
  for (const id of deleted) byId.delete(id);

  // 消した夢の「事実カード」（名前や原文の抜き出し）も、いっしょに片づける
  const removed = (Array.isArray(body.delete) ? body.delete : []).filter((id) => typeof id === "string");
  if (removed.length) {
    const cardStore = getStore({ name: "dream-cards", consistency: "strong" });
    await Promise.all(removed.map((id) => cardStore.delete(id).catch((e) => console.log("card delete error", e))));
  }

  const next = { dreams: [...byId.values()], deleted: [...deleted] };
  await store.setJSON("dreams", next);

  let github = "error";
  try {
    github = await saveToGitHub(store, next.dreams);
  } catch (e) {
    console.log("GitHub save error", e);
  }
  return reply({ ...next, github });
};

export const config = { path: "/api/dreams" };
