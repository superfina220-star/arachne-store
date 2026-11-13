const storefrontOrigin = "https://arachne.okcept.ru";
const corsHeaders = {
  "Access-Control-Allow-Origin": storefrontOrigin,
  "Access-Control-Allow-Methods": "POST",
  "Access-Control-Allow-Headers": "Content-Type",
};
const photoTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function response(status, payload = { ok: false }) {
  return Response.json(payload, {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store" },
  });
}

async function telegram(env, method, body) {
  const isJson = !(body instanceof FormData);
  const result = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: isJson ? { "Content-Type": "application/json" } : undefined,
    body: isJson ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(12000),
  });
  if (!result.ok) return null;
  const data = await result.json();
  return data.ok === true ? data.result : null;
}

async function sendConsultation(request, env) {
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
  const isTelegram = /^@[A-Za-z0-9_]{5,32}$/.test(contact);
  const isPhone = contact.length <= 33 && /^[+]?[0-9 ()-]+$/.test(contact)
    && /^[0-9]{7,15}$/.test(contact.replace(/[^0-9]/g, ""));
  if (!question || question.length > 400 || (!isTelegram && !isPhone)) {
    return response(400);
  }
  const text = ["Арахна · вопрос с сайта", question, (isTelegram ? "Telegram: " : "Телефон: ") + contact]
    .filter(Boolean).join("\n\n");
  const sent = await telegram(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true },
  });
  return sent ? response(200, { ok: true }) : response(502);
}

async function sendOrder(request, env) {
  if (Number(request.headers.get("Content-Length")) > 11 * 1024 * 1024) return response(413);
  let data, photo;
  try {
    const form = await request.formData();
    data = JSON.parse(form.get("order"));
    photo = form.get("photo");
  } catch {
    return response(400);
  }
  const limits = { configuration: 360, measures: 350, delivery: 500, customer: 100, phone: 24, email: 150, note: 600 };
  if (!data || typeof data.wantsPayment !== "boolean" || Object.entries(limits).some(
    ([key, limit]) => typeof data[key] !== "string" || data[key].length > limit
  )) return response(400);

  const { configuration, measures, delivery, customer, phone, email, note, wantsPayment } = data;
  if (![configuration, measures, delivery, customer].every(value => value.trim())
    || phone.replace(/[^0-9]/g, "").length < 7
    || (email && !/^[^\s@]+@[^\s@]+$/.test(email))) return response(400);
  if (photo !== null && (!(photo instanceof File) || photo.size === 0
    || photo.size > 10 * 1024 * 1024 || !photoTypes.has(photo.type))) return response(400);

  const orderId = crypto.randomUUID().split("-")[0].toUpperCase();
  const text = [
    "Арахна · заявка № " + orderId,
    wantsPayment ? "Выбрана оплата через Робокассу · платёж 1 ₽ нужно сверить" : "Без оплаты · связаться с покупателем",
    "Модель: " + configuration,
    "Мерки: " + measures,
    "Получение: " + delivery,
    "Имя: " + customer,
    "Телефон: " + phone,
    email && "Email: " + email,
    note && "Пожелания: " + note,
  ].filter(Boolean).join("\n");
  const sent = await telegram(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true },
  });
  if (!sent) return response(502);

  let photoSent = false;
  if (photo) {
    const attachment = new FormData();
    attachment.set("chat_id", env.TELEGRAM_CHAT_ID);
    attachment.set("caption", "Фото к заявке № " + orderId);
    attachment.set("document", photo);
    try {
      photoSent = Boolean(await telegram(env, "sendDocument", attachment));
    } catch {
      // Заявка уже доставлена. Сообщаем отдельно о результате отправки фото.
    }
  }
  return response(200, { ok: true, orderId, photoSent });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== "/api/consult" && pathname !== "/api/order") return response(404);
    if (request.headers.get("Origin") !== storefrontOrigin) return response(403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== "POST") return response(405);
    const contentType = request.headers.get("Content-Type")?.split(";")[0];
    const order = pathname === "/api/order";
    if (contentType !== (order ? "multipart/form-data" : "application/json")) return response(415);
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.CONSULT_LIMIT) return response(503);

    try {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.CONSULT_LIMIT.limit({ key: ip });
      if (!success) return response(429);
      return order ? await sendOrder(request, env) : await sendConsultation(request, env);
    } catch {
      return response(502);
    }
  },
};

// Keep the existing Cloudflare storage namespace intact during the rollback.
export class PaymentNotice {
  fetch() {
    return new Response(null, { status: 404 });
  }
}
