// 夢のノートの「事実カード」の窓口。
// 夢を1件だけ Claude Haiku 5.5 に読ませて、人物・場所・食べ物などを抜き出した「カード」を作る。
// 全部の夢をまとめて読ませると、夢が増えるほど重くなって時間切れになるので、
// 1件ずつカードにして保管しておき、数えるのはページ側（AIなし）でやる。
// 一度作ったカードは、その夢を書き直さないかぎり作り直さない。
//
// GET  /api/card        … 保管してあるカードを全部返す
// POST /api/card {dream} … その夢のカードを作って保管し、返す
//
// 呼べるのは、環境変数 DREAM_KEY と同じ「あいことば」を送ってきた端末だけ。
// AI のキーは環境変数 ANTHROPIC_API_KEY に置き、ページには出さない。
// 夢の意味は解釈しない。記録から読み取れることだけを抜き出す。

import { getStore } from "@netlify/blobs";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  // GitHub Pages版からも呼べるように、ほかの場所からの呼び出しも受ける
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-dream-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const MODEL = "claude-haiku-5-5";
// 1件の夢の長さの上限（文字数）
const MAX_CHARS = 20000;

const SYSTEM = `あなたは夢日記の記録整理を担当するAIです。
1件の夢の記録を読み、書かれている事実だけを、項目ごとに抜き出してください。

項目：
- people（人物）：記録に出てくる人。「出てきた人」の欄に書かれた人も含める。
- places（場所）：場面になっている場所。
- foods（食べ物）：出てくる食べ物・飲み物。
- moves（乗り物・移動）：乗り物や、どこかへ向かう移動（車、バス、汽車、徒歩で向かう など）。
- tech（AI・IT・作業）：AI、コード、画面、表計算、エラー、データ作業など。
- outcomes（問題と結果）：問題への対処が描かれている場面。result は「解決できた」「解決できなかった」「結果不明」のどれか。
- changes（変化・すり替わり）：夢の中で、物・人・場所が別のものに変わった場面。before に変わる前、after に変わったあと。
- notReal（できたと思ったら夢だった）：現実でできた・起きたと思ったのに、それ自体が夢の中のことだった場面。what に、何ができたと思ったのか。

決まりごと：
- name は短い名詞にする。記録の言葉や呼び方に沿う（例：サトウくん、母親のような人、海老天蕎麦、車）。
- 同じ夢の中で同じものは1回だけ入れる。
- quote には、根拠になる記述を記録から原文のまま短く抜き出す。
- はっきり書かれていないものは入れない。記録にない出来事を補わない。
- 夢の心理的意味、性格、精神状態、象徴について解釈しない。
- 当てはまるものがなければ、空の配列にする。`;

const QUOTE = { type: "string", description: "根拠になる記述。記録から原文のまま短く抜き出す" };
const ITEMS = {
  type: "array",
  items: {
    type: "object",
    properties: { name: { type: "string", description: "短い名詞。記録の言葉に沿う" }, quote: QUOTE },
    required: ["name", "quote"],
    additionalProperties: false,
  },
};

const SCHEMA = {
  type: "object",
  properties: {
    people: ITEMS,
    places: ITEMS,
    foods: ITEMS,
    moves: ITEMS,
    tech: ITEMS,
    outcomes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          problem: { type: "string" },
          action: { type: "string" },
          result: { type: "string", enum: ["解決できた", "解決できなかった", "結果不明"] },
          quote: QUOTE,
        },
        required: ["problem", "action", "result", "quote"],
        additionalProperties: false,
      },
    },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: { before: { type: "string" }, after: { type: "string" }, quote: QUOTE },
        required: ["before", "after", "quote"],
        additionalProperties: false,
      },
    },
    notReal: {
      type: "array",
      items: {
        type: "object",
        properties: { what: { type: "string" }, quote: QUOTE },
        required: ["what", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["people", "places", "foods", "moves", "tech", "outcomes", "changes", "notReal"],
  additionalProperties: false,
};

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function dreamText(d) {
  const lines = ["見た日：" + (d.date || "不明")];
  if (d.title) lines.push("タイトル：" + d.title);
  if (d.people) lines.push("出てきた人：" + d.people);
  lines.push("内容：", String(d.body || ""));
  return lines.join("\n");
}

// AI に1件読ませる。うまくいかなかったときは、画面に出す言葉を error に入れて返す。
async function makeCard(apiKey, d) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: dreamText(d) }],
      }),
    });
  } catch (e) {
    console.log("card fetch error", e);
    return { error: "AIにつながりませんでした。少し待ってからもう一度試してね。" };
  }

  if (!res.ok) {
    const text = await res.text();
    console.log("card api error", res.status, text);
    if (res.status === 401) return { error: "ANTHROPIC_API_KEY が正しくないみたい。Netlifyの設定を見直してね。" };
    if (res.status === 429) return { error: "いまは呼び出しが多すぎるみたい。少し待ってからもう一度試してね。" };
    if (res.status >= 500) return { error: "AIのほうが混み合っているみたい。少し待ってからもう一度試してね。" };
    let msg = "";
    try { msg = JSON.parse(text).error.message; } catch { msg = text.slice(0, 200); }
    return { error: "AIに断られました（" + msg + "）" };
  }

  const data = await res.json();
  if (data.stop_reason === "refusal") return { error: "AIがこの夢の整理を断りました。" };
  if (data.stop_reason === "max_tokens") return { error: "この夢が長くて、最後までまとめきれませんでした。" };
  const block = (data.content || []).find((b) => b.type === "text");
  try {
    return { card: JSON.parse(block.text) };
  } catch {
    return { error: "AIの返事が読み取れませんでした。もう一度試してみてね。" };
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  const secret = Netlify.env.get("DREAM_KEY");
  if (!secret) return reply({ error: "DREAM_KEY がまだ設定されていません" }, 500);
  // 日本語のあいことばも使えるように、送る側でエンコードしてある
  if (req.headers.get("x-dream-key") !== encodeURIComponent(secret)) return reply({ error: "あいことばが違います" }, 401);

  const store = getStore({ name: "dream-cards", consistency: "strong" });

  // 保管してあるカードを全部返す（夢の id → カード）
  if (req.method === "GET") {
    const { blobs } = await store.list();
    const entries = await Promise.all(
      blobs.map(async (b) => [b.key, await store.get(b.key, { type: "json" })])
    );
    const cards = {};
    for (const [k, v] of entries) if (v) cards[k] = v;
    return reply({ cards });
  }
  if (req.method !== "POST") return reply({ error: "使えない呼び方です" }, 405);

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return reply({ error: "AIのキー（ANTHROPIC_API_KEY）が、まだNetlifyに設定されていません。" }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "中身が読めませんでした" }, 400);
  }
  const d = body && body.dream;
  if (!d || typeof d.id !== "string" || !/^[\w-]{1,64}$/.test(d.id) || typeof d.body !== "string") {
    return reply({ error: "夢の中身が読めませんでした" }, 400);
  }
  if (dreamText(d).length > MAX_CHARS) return reply({ error: "この夢は長すぎて、カードにできません。" }, 413);

  // AI の返事を待つあいだは空白を少しずつ送り、つながりが切れないようにする（JSON は前に空白があっても読める）
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (s) => {
        try { controller.enqueue(encoder.encode(s)); } catch { /* ページが閉じられた */ }
      };
      send(" ");
      const keepAlive = setInterval(() => send(" "), 5000);
      let out;
      try {
        out = await makeCard(apiKey, d);
        if (out.card) {
          const saved = { stamp: Number(d.stamp) || 0, at: Date.now(), model: MODEL, card: out.card };
          await store.setJSON(d.id, saved);
          out = saved;
        }
      } catch (e) {
        console.log("card error", e);
        out = { error: "カードを作る途中でうまくいきませんでした。もう一度試してみてね。" };
      }
      clearInterval(keepAlive);
      send(JSON.stringify(out));
      try { controller.close(); } catch { /* すでに閉じられている */ }
    },
  });
  return new Response(stream, { headers: HEADERS });
};

export const config = { path: "/api/card" };
