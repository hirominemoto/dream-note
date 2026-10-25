// 夢のノートの「AIで整理する」窓口。
// これまでの夢を Claude（Anthropic の AI）に渡し、繰り返し出てくるものや、行動とその結果を数えて返す。
// 夢の意味は解釈しない。記録から読み取れることだけを抜き出す。
// 呼べるのは、環境変数 DREAM_KEY と同じ「あいことば」を送ってきた端末だけ。
// AI のキーは環境変数 ANTHROPIC_API_KEY に置き、ページには出さない。
//
// ふつうの Netlify Functions は10秒ほどで打ち切られてしまうので、待ち時間に強い Edge Functions にしている。
// AI の返事を待つあいだは空白を少しずつ送り、つながりが切れないようにする（JSON は前に空白があっても読める）。

import Anthropic from "@anthropic-ai/sdk";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  // GitHub Pages版からも呼べるように、ほかの場所からの呼び出しも受ける
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-dream-key",
  "access-control-allow-methods": "POST, OPTIONS",
};

// 一度に送れる記録の長さの上限（文字数）。これを超えると費用も時間もかかりすぎるので断る。
const MAX_CHARS = 200000;

const SYSTEM = `あなたは夢日記の記録整理を担当するAIです。

目的：複数の夢日記を横断して、記録者自身が気づきにくい共通点、繰り返し登場する要素、行動とその結果を抽出・整理してください。

1. 人物、場所、物、乗り物、行動、出来事などの繰り返しを探す。
2. 表現が異なっていても、具体的な行動に共通性がある場合はまとめてよい。
3. 問題への対処が描かれている場合は、解決できた・できなかった・結果不明に分類する。
4. 件数を示し、根拠となる夢の日付・タイトル・具体的な記述を添える。
5. 曖昧な記録は断定せず、不明として扱う。
6. 夢の心理的意味、性格、精神状態、象徴について解釈しない。
7. 記録にない出来事を補わない。共通点を無理に作らない。
8. 記録者への助言や結論は不要。

出力：共通点ごとの件数、該当する夢、具体的な事実、行動の結果を整理して示す。

出力の形について：
- 夢には [1] [2] … の番号がついています。夢を示すときは番号（dream）だけを書いてください。日付とタイトルは、画面側で番号から補います。
- patterns：2件以上の夢に繰り返し出てくる要素だけを入れる。kind はその種類、label はその共通点を短く言い表した名前。evidence には、該当する夢ごとに1つずつ、dream（番号）と quote（その夢の記録から、根拠になる部分を原文のまま短く抜き出したもの）を入れる。同じ夢を二度入れない。件数は evidence の数として画面側で数えるので、書かなくてよい。
- outcomes：問題への対処が描かれている場面ごとに1つ。problem は問題、action はとった行動（どちらも記録の言葉に沿って短く）、result は「解決できた」「解決できなかった」「結果不明」のどれか、quote は根拠になる記述を原文のまま短く抜き出したもの。
- unclear：曖昧で、共通点や結果に入れるかどうか判断できなかった記録。note には、記録のどこが曖昧だったかを書く。
- 当てはまるものがなければ、空の配列にする。`;

const DREAM_REF = { type: "integer", description: "夢の番号" };
const QUOTE = { type: "string", description: "根拠になる記述。記録から原文のまま短く抜き出す" };

const SCHEMA = {
  type: "object",
  properties: {
    patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["人物", "場所", "物", "乗り物", "行動", "出来事", "その他"] },
          label: { type: "string", description: "共通点を短く言い表した名前" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: { dream: DREAM_REF, quote: QUOTE },
              required: ["dream", "quote"],
              additionalProperties: false,
            },
          },
        },
        required: ["kind", "label", "evidence"],
        additionalProperties: false,
      },
    },
    outcomes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dream: DREAM_REF,
          problem: { type: "string" },
          action: { type: "string" },
          result: { type: "string", enum: ["解決できた", "解決できなかった", "結果不明"] },
          quote: QUOTE,
        },
        required: ["dream", "problem", "action", "result", "quote"],
        additionalProperties: false,
      },
    },
    unclear: {
      type: "array",
      items: {
        type: "object",
        properties: { dream: DREAM_REF, note: { type: "string" } },
        required: ["dream", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["patterns", "outcomes", "unclear"],
  additionalProperties: false,
};

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

// 夢を見た日の古い順に [1] [2] … と番号をつけて、AI に読ませる形にする
function recordsText(dreams) {
  const parts = dreams.map((d, i) => {
    const lines = [`<dream n="${i + 1}">`, "見た日：" + (d.date || "不明")];
    if (d.title) lines.push("タイトル：" + d.title);
    if (d.people) lines.push("出てきた人：" + d.people);
    if (Array.isArray(d.tags) && d.tags.length) lines.push("目が覚めたときに残っている感じ：" + d.tags.join("、"));
    lines.push("内容：", String(d.body || ""), "</dream>");
    return lines.join("\n");
  });
  return `これまでの夢の記録です（全${dreams.length}件、見た日の古い順）。\n\n` + parts.join("\n\n");
}

async function summarize(apiKey, text) {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    // AI の安全確認で断られたときは、Anthropic がすすめる別のモデルで自動でやり直す
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: text }],
  });

  if (response.stop_reason === "refusal") {
    return { error: "AIがこの記録の整理を断りました。" };
  }
  if (response.stop_reason === "max_tokens") {
    return { error: "記録が多くて、最後までまとめきれませんでした。" };
  }
  const block = response.content.find((b) => b.type === "text");
  try {
    return { result: JSON.parse(block.text), model: response.model };
  } catch {
    return { error: "AIの返事が読み取れませんでした。もう一度試してみてね。" };
  }
}

function errorMessage(e) {
  console.log("summary error", e);
  if (e instanceof Anthropic.AuthenticationError) {
    return "ANTHROPIC_API_KEY が正しくないみたい。Netlifyの設定を見直してね。";
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return "このAPIキーでは、このAIを使えないみたい。";
  }
  if (e instanceof Anthropic.RateLimitError) {
    return "いまは呼び出しが多すぎるみたい。少し待ってからもう一度試してね。";
  }
  if (e instanceof Anthropic.InternalServerError) {
    return "AIのほうが混み合っているみたい。少し待ってからもう一度試してね。";
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return "AIにつながりませんでした。少し待ってからもう一度試してね。";
  }
  if (e instanceof Anthropic.APIError) {
    // 残高不足などは、Anthropic からの説明をそのまま見せる
    return "AIに断られました（" + (e.error?.error?.message || e.message) + "）";
  }
  return "整理の途中でうまくいきませんでした。もう一度試してみてね。";
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== "POST") return reply({ error: "使えない呼び方です" }, 405);

  const secret = Netlify.env.get("DREAM_KEY");
  if (!secret) return reply({ error: "DREAM_KEY がまだ設定されていません" }, 500);
  // 日本語のあいことばも使えるように、送る側でエンコードしてある
  if (req.headers.get("x-dream-key") !== encodeURIComponent(secret)) return reply({ error: "あいことばが違います" }, 401);

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
  // 番号は画面側と同じ並びでつけるので、ここでは夢をはじかない
  const dreams = (Array.isArray(body.dreams) ? body.dreams : []).filter((d) => d && typeof d === "object");
  if (dreams.length < 2) return reply({ error: "整理するには、夢が2件以上必要です。" }, 400);
  const text = recordsText(dreams);
  if (text.length > MAX_CHARS) return reply({ error: "記録が多すぎて、一度には整理できません。" }, 413);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (s) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          // ページが閉じられたあとは送れないので、何もしない
        }
      };
      send(" ");
      const keepAlive = setInterval(() => send(" "), 5000);
      let out;
      try {
        out = await summarize(apiKey, text);
      } catch (e) {
        out = { error: errorMessage(e) };
      }
      clearInterval(keepAlive);
      send(JSON.stringify(out));
      try {
        controller.close();
      } catch {
        // すでに閉じられている
      }
    },
  });
  return new Response(stream, { headers: HEADERS });
};

export const config = { path: "/api/summary" };
