// Логика страницы. Вынесена из index.html, чтобы её можно было проверить тестом без браузера.

export const TOPIC_LABELS = { delivery: "Доставка", pricing: "Цены", other: "Другое" };

// Сервер отвечает за 300 мс; запас нужен только на случай зависшей сети.
const CLIENT_TIMEOUT_MS = 5_000;

const EMPTY_INPUT = { kind: "invalid_input", message: "Введите текст заявки.", topic: "", draft: "" };
const PENDING = { kind: "pending", message: "Разбираем заявку…", topic: "", draft: "" };
const MANUAL_REVIEW = {
  kind: "manual_review",
  message: "Автоматический разбор не удался. Разберите заявку вручную: черновика нет.",
  topic: "",
  draft: "",
};

// Превращает текст заявки в то, что увидит менеджер. Черновик показывается только
// при корректном ответе ready; сбой сети, ошибка сервера и любой неожиданный ответ
// дают ручной разбор с пустым черновиком.
export async function triageView(text, fetchImpl = fetch) {
  if (typeof text !== "string" || text.trim() === "") return EMPTY_INPUT;
  try {
    const reply = await fetchImpl("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    const body = await reply.json();
    if (reply.status === 400 && body?.status === "invalid_input") return EMPTY_INPUT;
    if (
      reply.status === 200 &&
      body?.status === "ready" &&
      Object.hasOwn(TOPIC_LABELS, body.topic) &&
      typeof body.draft === "string" &&
      body.draft.trim() !== ""
    ) {
      return {
        kind: "ready",
        message: "Черновик готов. Проверьте его перед отправкой клиенту.",
        topic: TOPIC_LABELS[body.topic],
        draft: body.draft,
      };
    }
  } catch {
    // Сеть, таймаут или не-JSON в ответе: ниже вернём ручной разбор.
  }
  return MANUAL_REVIEW;
}

// Каждый раз записывает все поля, поэтому старый черновик не может остаться на экране.
function render(elements, view) {
  elements.status.textContent = view.message;
  elements.topic.textContent = view.topic;
  elements.draft.textContent = view.draft;
  elements.result.hidden = view.kind !== "ready";
}

export function bindTriageForm(elements, fetchImpl = fetch) {
  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (elements.button.disabled) return;
    elements.button.disabled = true;
    render(elements, PENDING);
    try {
      render(elements, await triageView(elements.input.value, fetchImpl));
    } finally {
      elements.button.disabled = false;
    }
  });
}
