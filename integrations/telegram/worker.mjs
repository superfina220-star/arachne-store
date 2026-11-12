const storefrontOrigin = "https://arachne.okcept.ru";
const route = "/api/consult";

function response(status, ok = false) {
  return Response.json({ ok }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== route) return response(404);
    if (request.method !== "POST") return response(405);
    if (url.origin !== storefrontOrigin || request.headers.get("Origin") !== storefrontOrigin) {
      return response(403);
    }
    if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") {
      return response(415);
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.CONSULT_LIMIT) {
      return response(503);
    }
    if (Number(request.headers.get("Content-Length")) > 8192) return response(413);

    let data;
    try {
      const body = await request.text();
      if (body.length > 8192) return response(413);
      data = JSON.parse(body);
    } catch {
      return response(400);
    }

    const question = typeof data?.question === "string" ? data.question.trim() : "";
    const contact = typeof data?.contact === "string" ? data.contact.trim() : "";
    if (!question || question.length > 400 || (contact && !/^@[A-Za-z0-9_]{5,32}$/.test(contact))) {
      return response(400);
    }

    try {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.CONSULT_LIMIT.limit({ key: ip });
      if (!success) return response(429);

      const text = [
        "Арахна · вопрос с сайта",
        question,
        contact && "Ответить: " + contact,
      ].filter(Boolean).join("\n\n");
      const sent = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (sent.ok && (await sent.json()).ok === true) return response(200, true);
    } catch {
      // Не раскрываем токен и содержимое обращения в ответах и логах.
    }
    return response(502);
  },
};
