// Pure helpers for turning a paused CDP request into an editable draft and back.
// Everything a person can type ends up here before it reaches the network, so this
// module is the actual security boundary: it rejects header/URL injection (CR/LF and
// other control characters), blocks changing a request's origin (which would hand the
// new origin the original's Cookie/Authorization), and caps preview/replacement sizes.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const AUTOMATIC_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_HEADERS_LENGTH = 128 * 1024;
export const MAX_URL_LENGTH = 16 * 1024;
const BODY_LIMIT_WARNING = "Тело больше 1 МиБ и не отображается. Без замены Chrome отправит исходные байты. Можно задать новое тело до 1 МиБ.";

export function parseHeaders(raw) {
  if (typeof raw !== "string" || raw.length > MAX_HEADERS_LENGTH || new TextEncoder().encode(raw).length > MAX_HEADERS_LENGTH) {
    throw new Error("Заголовки превышают лимит 128 КиБ.");
  }
  return raw.split(/\r?\n/).flatMap((line, index) => {
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) throw new Error(`Недопустимый символ в заголовке, строка ${index + 1}.`);
    if (!line.trim()) return [];
    const colon = line.indexOf(":");
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (colon < 1 || !TOKEN.test(name) || /[\r\0]/.test(line)) {
      throw new Error(`Некорректный заголовок в строке ${index + 1}. Формат: Name: value`);
    }
    return [{ name, value }];
  });
}

export function formatHeaders(headers) {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\n");
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function encodeBody(body, encoding) {
  if (encoding === "base64") {
    if (body.length > 2 * MAX_BODY_BYTES) throw new Error("Новое тело превышает лимит 1 МиБ.");
    const compact = body.replace(/\s/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
      throw new Error("Тело содержит некорректный Base64.");
    }
    if (atob(compact).length > MAX_BODY_BYTES) throw new Error("Новое тело превышает лимит 1 МиБ.");
    return compact;
  }
  if (encoding !== "utf8") throw new Error("Неизвестная кодировка тела.");
  if (body.length > MAX_BODY_BYTES) throw new Error("Новое тело превышает лимит 1 МиБ.");
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > MAX_BODY_BYTES) throw new Error("Новое тело превышает лимит 1 МиБ.");
  return bytesToBase64(bytes);
}

// Omit untouched fields so Chrome retains the original bytes, cookies and upload files.
export function buildOverride(original, draft) {
  if (!draft || typeof draft.url !== "string" || typeof draft.method !== "string" ||
      typeof draft.headers !== "string" || typeof draft.body !== "string") {
    throw new Error("Редактор передал неполный запрос.");
  }
  const url = draft.url.trim();
  if (url.length > MAX_URL_LENGTH || /[\x00-\x20\x7f]/.test(url)) throw new Error("URL слишком длинный или содержит недопустимые пробелы/управляющие символы.");
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Укажите полный URL запроса."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Нужен HTTP(S) URL без логина и пароля в адресе.");
  }
  // CDP may forward explicit Cookie/Authorization headers even to a new origin.
  // Keep the user's existing credentials within their original security boundary.
  if (parsed.origin !== new URL(original.url).origin) {
    throw new Error("Нельзя менять origin запроса (схему, хост или порт): это может передать токены и Cookie другому сайту.");
  }
  const method = draft.method.trim().toUpperCase();
  if (!TOKEN.test(method) || ["CONNECT", "TRACE", "TRACK"].includes(method)) {
    throw new Error("Укажите допустимый HTTP-метод.");
  }
  const headers = parseHeaders(draft.headers);
  const override = {};
  if (url !== original.url) override.url = url;
  if (method !== original.method) override.method = method;
  if (draft.replaceBody) {
    if (["GET", "HEAD"].includes(method) && draft.body.length) {
      throw new Error("Для GET и HEAD оставьте тело пустым или измените метод.");
    }
    override.postData = encodeBody(draft.body, draft.encoding);
  }
  if (draft.headers !== original.headers || draft.replaceBody || override.url || override.method) {
    override.headers = headers.filter(({ name }) => !AUTOMATIC_HEADERS.has(name.toLowerCase()));
  }
  return override;
}

export async function readBody(request) {
  const multipart = /multipart\/form-data/i.test(Object.entries(request.headers)
    .find(([name]) => name.toLowerCase() === "content-type")?.[1] || "");
  const entries = request.postDataEntries;
  if (entries?.length && entries.every((entry) => typeof entry.bytes === "string")) {
    const estimatedBytes = entries.reduce((sum, entry) => sum + Math.ceil(entry.bytes.length * 3 / 4), 0);
    if (estimatedBytes > MAX_BODY_BYTES) return { body: "", encoding: "utf8", bodyWarning: BODY_LIMIT_WARNING };
    const chunks = entries.map((entry) => Uint8Array.from(atob(entry.bytes), (c) => c.charCodeAt(0)));
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try {
      if (multipart) throw new Error("binary upload");
      return { body: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8", bodyWarning: "" };
    } catch {
      return { body: bytesToBase64(bytes), encoding: "base64", bodyWarning: "Бинарное тело показано в Base64. Для multipart сохраняйте boundary из Content-Type." };
    }
  }
  // Never fetch an omitted body of unknown size via Network.getRequestPostData.
  // The original upload stays in Chrome and may still be continued unchanged.
  const body = request.postData;
  if (body !== undefined && (body.length > MAX_BODY_BYTES || new TextEncoder().encode(body).length > MAX_BODY_BYTES)) {
    return { body: "", encoding: "utf8", bodyWarning: BODY_LIMIT_WARNING };
  }
  const warning = multipart
    ? "В представлении multipart могут отсутствовать файлы. Без замены тела Chrome отправит исходный upload целиком."
    : body === undefined && request.hasPostData
      ? "Chrome не предоставил тело. Без замены оно будет отправлено без изменений."
      : "";
  return { body: body ?? "", encoding: "utf8", bodyWarning: warning };
}

export function matchesRequest(params, options) {
  return /^https?:\/\//i.test(params.request.url) &&
    params.request.method !== "OPTIONS" &&
    (options.types === "all" || ["Fetch", "XHR"].includes(params.resourceType)) &&
    (!options.urlFilter || params.request.url.includes(options.urlFilter));
}
