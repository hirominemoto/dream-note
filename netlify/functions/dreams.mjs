// 夢のノートの保管庫。PCとスマホが同じノートを見るための窓口。
// 夢そのものは Netlify Blobs に1つのファイル（dreams）として置いておく。
// 読み書きできるのは、環境変数 DREAM_KEY と同じ「あいことば」を送ってきた端末だけ。

import { getStore } from "@netlify/blobs";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  // 古いGitHub Pages版から引っ越しするときに呼べるように、ほかの場所からの呼び出しも受ける
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-dream-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

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

  // 新しく届いた夢を足す（同じ id がもうあれば、そのまま）
  const byId = new Map(data.dreams.map((d) => [d.id, d]));
  for (const d of Array.isArray(body.upsert) ? body.upsert : []) {
    if (!d || typeof d.id !== "string" || typeof d.body !== "string") continue;
    if (!byId.has(d.id)) byId.set(d.id, d);
  }
  for (const id of deleted) byId.delete(id);

  const next = { dreams: [...byId.values()], deleted: [...deleted] };
  await store.setJSON("dreams", next);
  return reply(next);
};

export const config = { path: "/api/dreams" };
