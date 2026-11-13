import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const invoiceApi = "https://services.robokassa.ru/InvoiceServiceWebApi/api/CreateInvoice";
const algorithms = { MD5: "md5", SHA256: "sha256", SHA384: "sha384", SHA512: "sha512" };

function paymentConfig(env) {
  const algorithm = env.ROBOKASSA_HASH || "MD5";
  if (env.ROBOKASSA_ENABLED !== "1" || !Object.hasOwn(algorithms, algorithm) || !env.ROBOKASSA_MERCHANT_LOGIN
    || !env.ROBOKASSA_PASSWORD_1 || !env.ROBOKASSA_PASSWORD_2
    || !env.ROBOKASSA_RECEIPT_TAX || !env.PAYMENT_NOTICES) return null;
  const amount = Number(env.ROBOKASSA_AMOUNT || "1");
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 7700) return null;
  return { algorithm, hash: algorithms[algorithm], amount };
}

export function paymentConfigured(env) {
  return Boolean(paymentConfig(env));
}

export async function createPayment(env, orderId, telegramMessageId) {
  const { algorithm, hash, amount } = paymentConfig(env);
  const merchant = env.ROBOKASSA_MERCHANT_LOGIN;
  const description = "Предоплата за изготовление свитера, заявка № " + orderId;
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ typ: "JWT", alg: algorithm });
  const payload = encode({
    MerchantLogin: merchant,
    InvoiceType: "OneTime",
    Culture: "ru",
    OutSum: amount,
    Description: description,
    InvoiceItems: [{
      Name: description,
      Quantity: 1,
      Cost: amount,
      Tax: env.ROBOKASSA_RECEIPT_TAX,
      PaymentMethod: amount === 7700 ? "full_prepayment" : "prepayment",
      PaymentObject: "job",
    }],
  });
  const input = header + "." + payload;
  const signature = createHmac(hash, merchant + ":" + env.ROBOKASSA_PASSWORD_1)
    .update(input).digest("base64url");
  const response = await fetch(invoiceApi, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input + "." + signature),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Invoice API failed");
  const invoice = await response.json();
  const invoiceId = String(invoice.invId);
  if (!invoice.isSuccess || !/^[1-9][0-9]{0,18}$/.test(invoiceId)
    || !/^https:\/\/auth\.robokassa\.ru\/merchant\/invoice\/[a-z0-9_-]+$/i.test(invoice.url)) {
    throw new Error("Invalid invoice");
  }
  const saved = await env.PAYMENT_NOTICES.getByName(invoiceId).fetch("https://payments.internal/register", {
    method: "POST",
    body: JSON.stringify({ orderId, amount, telegramMessageId, chatId: env.TELEGRAM_CHAT_ID }),
  });
  if (!saved.ok) throw new Error("Could not associate invoice and order");
  return { url: invoice.url, amount };
}

export async function receivePayment(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const config = paymentConfig(env);
  if (!config || !env.TELEGRAM_BOT_TOKEN) return new Response(null, { status: 503 });
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
    return new Response(null, { status: 415 });
  }
  if (Number(request.headers.get("Content-Length")) > 8192) return new Response(null, { status: 413 });
  const body = await request.text();
  if (body.length > 8192) return new Response(null, { status: 413 });
  const fields = new URLSearchParams(body);
  const sum = fields.get("OutSum") || "";
  const invoiceId = fields.get("InvId") || "";
  const signature = fields.get("SignatureValue") || "";
  if (!/^[1-9][0-9]{0,18}$/.test(invoiceId) || !/^\d{1,12}(\.\d{1,6})?$/.test(sum)) {
    return new Response(null, { status: 400 });
  }
  const parts = [sum, invoiceId, env.ROBOKASSA_PASSWORD_2];
  for (const key of [...fields.keys()].filter(key => key.startsWith("Shp_")).sort()) {
    parts.push(key + "=" + fields.get(key));
  }
  const expected = createHash(config.hash).update(parts.join(":")).digest("hex");
  if (signature.length !== expected.length || !/^[a-f0-9]+$/i.test(signature)
    || !timingSafeEqual(Buffer.from(signature.toLowerCase()), Buffer.from(expected))) {
    return new Response(null, { status: 403 });
  }
  return env.PAYMENT_NOTICES.getByName(invoiceId).fetch("https://payments.internal/confirm", {
    method: "POST",
    body: JSON.stringify({ amount: Number(sum), invoiceId }),
  });
}

export class PaymentNotice {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pending = null;
  }

  async fetch(request) {
    const data = await request.json();
    if (new URL(request.url).pathname === "/register") {
      return this.state.storage.transaction(async storage => {
        if (await storage.get("order")) return new Response(null, { status: 409 });
        await storage.put("order", data);
        return new Response(null, { status: 204 });
      });
    }

    const order = await this.state.storage.get("order");
    if (!order) return new Response(null, { status: 404 });
    if (data.amount !== order.amount) return new Response(null, { status: 400 });
    this.pending ??= this.notify(order, data.invoiceId).finally(() => { this.pending = null; });
    return new Response(await this.pending, { headers: { "Content-Type": "text/plain" } });
  }

  async notify(order, invoiceId) {
    const acknowledgement = "OK" + invoiceId;
    if (await this.state.storage.get("notified")) return acknowledgement;
    const amount = new Intl.NumberFormat("ru-RU").format(order.amount);
    const reply = await fetch("https://api.telegram.org/bot" + this.env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: order.chatId,
        text: "✅ Оплата получена по заявке № " + order.orderId + " — " + amount + " ₽.\nСчёт Робокассы № " + invoiceId,
        reply_parameters: { message_id: order.telegramMessageId, allow_sending_without_reply: true },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!reply.ok || (await reply.json()).ok !== true) throw new Error("Payment notification not delivered");
    await this.state.storage.put("notified", true);
    return acknowledgement;
  }
}
