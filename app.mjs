import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify as mockClassify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;
export const TOPICS = ["delivery", "pricing", "other"];

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const staticFiles = {
  "/": { type: "text/html; charset=utf-8", body: await readFile(new URL("./index.html", import.meta.url)) },
  "/triage-client.mjs": {
    type: "text/javascript; charset=utf-8",
    body: await readFile(new URL("./triage-client.mjs", import.meta.url)),
  },
};

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Возвращает текст заявки или null, если тело запроса не подходит:
// битый JSON, не объект, нет поля text, text не строка либо состоит из пробелов.
function parseText(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const text = body?.text;
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

// Ждёт модель не дольше timeoutMs. Сигнал отмены передаётся модели, а гонка
// с ним нужна на случай, если модель сигнал игнорирует и продолжает висеть.
function callModel(classify, text, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([classify(text, { signal }), timedOut]);
}

// Единственное место, где проверяется ответ AI. Возвращает { topic, draft }
// или null, если ответ нельзя показывать менеджеру.
export function parseModelReply(reply) {
  if (typeof reply !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { topic, draft } = parsed;
  if (!TOPICS.includes(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

export function createApp({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  async function triage(text) {
    try {
      const result = parseModelReply(await callModel(classify, text, timeoutMs));
      if (result) return { status: "ready", ...result };
    } catch {
      // Таймаут или ошибка модели: менеджер разбирает заявку сам.
    }
    return MANUAL_REVIEW;
  }

  async function handleTriage(request, response) {
    const text = parseText(await readBody(request));
    if (text === null) return json(response, 400, { status: "invalid_input" });
    return json(response, 200, await triage(text));
  }

  return createServer(async (request, response) => {
    const file = request.method === "GET" ? staticFiles[request.url] : undefined;
    if (file) {
      response.writeHead(200, { "Content-Type": file.type });
      response.end(file.body);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch {
      if (!response.headersSent) json(response, 500, { status: "server_error" });
    }
  });
}
