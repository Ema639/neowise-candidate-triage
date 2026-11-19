import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createApp } from "../app.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

// Поднимает приложение на свободном порту и возвращает функцию для запросов к нему.
function startApp(options) {
  const server = createApp(options);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        origin,
        close: () => new Promise((done) => server.close(done)),
        async post(rawBody) {
          const reply = await fetch(`${origin}/api/triage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: rawBody,
          });
          return { status: reply.status, body: await reply.json() };
        },
      });
    });
  });
}

describe("POST /api/triage с выданным имитатором", () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.close());

  const triage = (text) => app.post(JSON.stringify({ text }));

  test("обычная заявка: ready с темой и черновиком", async () => {
    assert.deepEqual(await triage("Когда будет доставка заказа?"), {
      status: 200,
      body: { status: "ready", topic: "delivery", draft: "Спасибо за обращение. Уточним детали заявки." },
    });
    assert.equal((await triage("Какая цена подписки?")).body.topic, "pricing");
    assert.equal((await triage("Здравствуйте!")).body.topic, "other");
  });

  for (const [name, rawBody] of [
    ["пустая строка", JSON.stringify({ text: "" })],
    ["строка из пробелов", JSON.stringify({ text: " \n\t " })],
    ["нет поля text", JSON.stringify({ message: "Где заказ?" })],
    ["text — число", JSON.stringify({ text: 42 })],
    ["text — null", JSON.stringify({ text: null })],
    ["text — массив", JSON.stringify({ text: ["Где заказ?"] })],
    ["тело — null", "null"],
    ["тело — строка", JSON.stringify("Где заказ?")],
    ["битый JSON", '{"text": "Где заказ?"'],
    ["пустое тело", ""],
  ]) {
    test(`некорректный ввод (${name}): 400 invalid_input`, async () => {
      assert.deepEqual(await app.post(rawBody), { status: 400, body: { status: "invalid_input" } });
    });
  }

  for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    test(`сбой модели ${marker}: manual_review без темы и черновика`, async () => {
      assert.deepEqual(await triage(`Вопрос о доставке ${marker}`), { status: 200, body: MANUAL_REVIEW });
    });
  }

  test("таймаут модели [timeout]: manual_review примерно через 300 мс", async () => {
    const startedAt = performance.now();
    const reply = await triage("Вопрос о доставке [timeout]");
    const elapsedMs = performance.now() - startedAt;

    assert.deepEqual(reply, { status: 200, body: MANUAL_REVIEW });
    // Имитатор отвечает через 1200 мс, поэтому ответ быстрее 900 мс доказывает, что его не дожидались.
    assert.ok(elapsedMs >= 290, `ответ пришёл раньше лимита: ${elapsedMs} мс`);
    assert.ok(elapsedMs < 900, `ответ пришёл слишком поздно: ${elapsedMs} мс`);
  });

  test("после сбоя следующая заявка обрабатывается как обычно", async () => {
    assert.deepEqual((await triage("[error]")).body, MANUAL_REVIEW);
    assert.equal((await triage("Сколько стоит доставка?")).body.status, "ready");
  });

  test("страница и её скрипт отдаются", async () => {
    const page = await fetch(`${app.origin}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);

    const script = await fetch(`${app.origin}/triage-client.mjs`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /^text\/javascript/);
  });
});

describe("POST /api/triage с подменённой моделью", () => {
  async function triageWith(classify, timeoutMs = 50) {
    const app = await startApp({ classify, timeoutMs });
    try {
      return await app.post(JSON.stringify({ text: "Где мой заказ?" }));
    } finally {
      await app.close();
    }
  }

  test("модель игнорирует сигнал отмены и не отвечает: manual_review по таймауту", async () => {
    const reply = await triageWith(() => new Promise(() => {}));
    assert.deepEqual(reply, { status: 200, body: MANUAL_REVIEW });
  });

  for (const [name, modelReply] of [
    ["не строка", { topic: "delivery", draft: "Текст" }],
    ["JSON null", "null"],
    ["JSON-массив", "[]"],
    ["нет темы", JSON.stringify({ draft: "Текст" })],
    ["тема не из списка, но есть у Object.prototype", JSON.stringify({ topic: "constructor", draft: "Текст" })],
    ["нет черновика", JSON.stringify({ topic: "delivery" })],
    ["черновик — число", JSON.stringify({ topic: "delivery", draft: 7 })],
  ]) {
    test(`неподходящий ответ модели (${name}): manual_review`, async () => {
      assert.deepEqual(await triageWith(async () => modelReply), { status: 200, body: MANUAL_REVIEW });
    });
  }

  test("в ответ попадают только тема и черновик, лишние поля модели отбрасываются", async () => {
    const reply = await triageWith(async () =>
      JSON.stringify({ topic: "pricing", draft: "  Текст  ", status: "manual_review", secret: "x" }),
    );
    assert.deepEqual(reply, { status: 200, body: { status: "ready", topic: "pricing", draft: "Текст" } });
  });
});
