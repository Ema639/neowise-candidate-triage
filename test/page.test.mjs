import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { bindTriageForm } from "../triage-client.mjs";

const READY = { status: "ready", topic: "delivery", draft: "Спасибо за обращение." };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

// Минимальная замена элементов страницы: тест проверяет настоящий обработчик формы
// из triage-client.mjs, но без браузера.
function fakePage(fetchImpl) {
  const elements = {
    form: { addEventListener: (_type, handler) => (elements.form.submit = handler) },
    input: { value: "" },
    button: { disabled: false },
    status: { textContent: "" },
    result: { hidden: true },
    topic: { textContent: "" },
    draft: { textContent: "" },
  };
  bindTriageForm(elements, fetchImpl);
  return {
    elements,
    async submit(text) {
      elements.input.value = text;
      await elements.form.submit({ preventDefault() {} });
    },
  };
}

// Подменяет fetch: каждый вызов отдаёт следующий ответ из списка.
function fakeFetch(...replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { calls, fetchImpl };
}

const jsonReply = (status, body) => ({ status, json: async () => body });

async function submitAfterSuccess(failure) {
  const { fetchImpl } = fakeFetch(jsonReply(200, READY), failure);
  const page = fakePage(fetchImpl);

  await page.submit("Когда доставка?");
  assert.equal(page.elements.draft.textContent, READY.draft);
  assert.equal(page.elements.topic.textContent, "Доставка");
  assert.equal(page.elements.result.hidden, false);

  await page.submit("Когда доставка? [timeout]");
  return page.elements;
}

for (const [name, failure] of [
  ["ответ manual_review", jsonReply(200, MANUAL_REVIEW)],
  ["сеть недоступна", new TypeError("Failed to fetch")],
  ["ошибка сервера 500", jsonReply(500, { status: "server_error" })],
  ["в ответе не JSON", { status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } }],
  ["ready с неизвестной темой", jsonReply(200, { ...READY, topic: "refund" })],
  ["ready с пустым черновиком", jsonReply(200, { ...READY, draft: "  " })],
  ["ready с ошибочным HTTP-статусом", jsonReply(500, READY)],
]) {
  test(`сбой после успешного разбора (${name}): сообщение о ручном разборе, старый черновик очищен`, async () => {
    const elements = await submitAfterSuccess(failure);

    assert.match(elements.status.textContent, /вручную/);
    assert.equal(elements.draft.textContent, "");
    assert.equal(elements.topic.textContent, "");
    assert.equal(elements.result.hidden, true);
    assert.equal(elements.button.disabled, false);
  });
}

test("пустой ввод: запрос не отправляется, старый черновик очищен", async () => {
  const { calls, fetchImpl } = fakeFetch(jsonReply(200, READY));
  const page = fakePage(fetchImpl);

  await page.submit("Когда доставка?");
  await page.submit("   ");

  assert.equal(calls.length, 1);
  assert.equal(page.elements.status.textContent, "Введите текст заявки.");
  assert.equal(page.elements.draft.textContent, "");
  assert.equal(page.elements.result.hidden, true);
});

test("ответ сервера invalid_input: просьба ввести текст, а не ручной разбор", async () => {
  const { fetchImpl } = fakeFetch(jsonReply(400, { status: "invalid_input" }));
  const page = fakePage(fetchImpl);

  await page.submit("Текст");

  assert.equal(page.elements.status.textContent, "Введите текст заявки.");
  assert.equal(page.elements.result.hidden, true);
});

test("пока идёт запрос, старый черновик уже скрыт, а кнопка заблокирована", async () => {
  let release;
  const slowReply = new Promise((resolve) => (release = resolve));
  const replies = [Promise.resolve(jsonReply(200, READY)), slowReply];
  const page = fakePage(() => replies.shift());

  await page.submit("Когда доставка?");
  const pending = page.submit("Сколько стоит?");

  assert.equal(page.elements.draft.textContent, "");
  assert.equal(page.elements.result.hidden, true);
  assert.equal(page.elements.button.disabled, true);

  release(jsonReply(200, { status: "ready", topic: "pricing", draft: "Про цену." }));
  await pending;

  assert.equal(page.elements.topic.textContent, "Цены");
  assert.equal(page.elements.draft.textContent, "Про цену.");
  assert.equal(page.elements.button.disabled, false);
});

test("в index.html есть все элементы, к которым обращается скрипт страницы", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const id of ["message", "status", "result", "topic", "draft"]) {
    assert.match(html, new RegExp(`id="${id}"`), `нет элемента #${id}`);
    if (id !== "message") assert.match(html, new RegExp(`querySelector\\("#${id}"\\)`));
  }
});
