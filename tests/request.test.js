import test from "node:test";
import assert from "node:assert/strict";
import { buildOverride, encodeBody, matchesRequest, parseHeaders, readBody, MAX_BODY_BYTES } from "../src/request.js";

const original = { url: "https://example.test/api?x=1", method: "POST", headers: "Content-Type: application/json\nCookie: session=abc\nContent-Length: 2", body: "{}" };
const draft = (extra = {}) => ({ ...original, replaceBody: false, encoding: "utf8", ...extra });

test("untouched fields are omitted, preserving original upload bytes and headers", () => {
  assert.deepEqual(buildOverride(original, draft()), {});
});
test("URL, method, duplicate headers and Unicode body are passed to CDP", () => {
  const result = buildOverride(original, draft({
    url: "https://example.test/changed?q=2", method: "patch",
    headers: "Content-Type: application/json\nX-Test: one\nX-Test: two\nHost: bad\nContent-Length: 1\nConnection: close\nTransfer-Encoding: chunked",
    replaceBody: true, body: '{"name":"Тим 🚀"}',
  }));
  assert.equal(result.url, "https://example.test/changed?q=2");
  assert.equal(result.method, "PATCH");
  assert.deepEqual(result.headers, [{ name: "Content-Type", value: "application/json" }, { name: "X-Test", value: "one" }, { name: "X-Test", value: "two" }]);
  assert.equal(Buffer.from(result.postData, "base64").toString("utf8"), '{"name":"Тим 🚀"}');
});
test("empty body is an explicit override and binary base64 is preserved", () => {
  assert.equal(buildOverride(original, draft({ replaceBody: true, body: "" })).postData, "");
  assert.equal(encodeBody("AAEC /4A=\n", "base64"), "AAEC/4A=");
  assert.throws(() => encodeBody("%%%", "base64"), /Base64/);
});
test("malformed headers, unsupported schemes, methods and GET bodies are rejected", () => {
  for (const headers of ["Broken", "X-Bad\r: value", "Bad Name: x", "X-Test: a\0b"]) {
    assert.throws(() => parseHeaders(headers), /заголов/);
  }
  for (const url of ["javascript:alert(1)", "file:///tmp/test", "/relative", "https://a:b@example.test/"]) {
    assert.throws(() => buildOverride(original, draft({ url })));
  }
  for (const method of ["POST\nGET", "TRACE", "CONNECT", ""]) assert.throws(() => buildOverride(original, draft({ method })));
  assert.throws(() => buildOverride(original, draft({ method: "GET", replaceBody: true, body: "abc" })), /GET/);
});
test("header values may contain colons and an empty value", () => {
  assert.deepEqual(parseHeaders("Authorization: Bearer a:b\nX-Empty:\n"), [
    { name: "Authorization", value: "Bearer a:b" }, { name: "X-Empty", value: "" },
  ]);
});
test("body preview handles text, binary entries, multipart and unavailable uploads", async () => {
  assert.equal((await readBody({ headers: {}, postData: "hello" })).body, "hello");
  const binary = await readBody({ headers: {}, postDataEntries: [{ bytes: "AAE=" }, { bytes: "/4A=" }] });
  assert.equal(binary.encoding, "base64");
  assert.equal(binary.body, "AAH/gA==");
  const multipart = await readBody({ headers: { "Content-Type": "multipart/form-data; boundary=x" }, postData: "partial" });
  assert.match(multipart.bodyWarning, /отсутствовать файлы/);
  const unavailable = await readBody({ headers: {}, hasPostData: true });
  assert.match(unavailable.bodyWarning, /не предоставил/);
});
test("capture filters skip OPTIONS, other resources, and unmatched URLs", () => {
  const request = { request: { method: "POST", url: "https://example.test/api/orders" }, resourceType: "Fetch" };
  const options = { types: "api", urlFilter: "/api" };
  assert.ok(matchesRequest(request, options));
  assert.ok(!matchesRequest({ ...request, request: { ...request.request, method: "OPTIONS" } }, options));
  assert.ok(!matchesRequest({ ...request, resourceType: "Document" }, options));
  assert.ok(matchesRequest({ ...request, resourceType: "Document" }, { ...options, types: "all" }));
  assert.ok(!matchesRequest(request, { ...options, urlFilter: "/missing" }));
});

test("origin changes cannot leak original cookies or authorization headers", () => {
  const secretRequest = { ...original, headers: "Authorization: Bearer secret\nCookie: session=private\nX-Api-Key: custom-secret" };
  for (const url of ["https://evil.test/api", "http://example.test/api", "https://example.test:8443/api", "https://example.test.evil.test/api"]) {
    assert.throws(() => buildOverride(secretRequest, { ...draft({ url }), headers: secretRequest.headers }), /origin/);
  }
  assert.equal(buildOverride(secretRequest, { ...draft({ url: "https://EXAMPLE.test/safe?x=2" }), headers: secretRequest.headers }).url, "https://EXAMPLE.test/safe?x=2");
});

test("all forbidden HTTP header control characters and whitespace before colon are rejected", () => {
  for (const code of [...Array(32).keys(), 127].filter((code) => code !== 9 && code !== 10)) {
    assert.throws(() => parseHeaders(`X-Test: a${String.fromCharCode(code)}b`), /заголов/);
  }
  assert.throws(() => parseHeaders(" X-Test: value"), /заголов/);
  assert.throws(() => parseHeaders("X-Test : value"), /заголов/);
  assert.deepEqual(parseHeaders("X-Test: hello\tworld"), [{ name: "X-Test", value: "hello\tworld" }]);
});

test("large previews are omitted without changing the upload; replacements are bounded by bytes", async () => {
  const largeBody = "a".repeat(MAX_BODY_BYTES + 1);
  const preview = await readBody({ headers: {}, postData: largeBody });
  assert.equal(preview.body, "");
  assert.match(preview.bodyWarning, /больше 1 МиБ/);
  const binary = await readBody({ headers: {}, postDataEntries: [{ bytes: Buffer.alloc(MAX_BODY_BYTES + 1).toString("base64") }] });
  assert.equal(binary.body, "");
  assert.throws(() => encodeBody(largeBody, "utf8"), /лимит/);
  assert.throws(() => encodeBody("я".repeat(MAX_BODY_BYTES / 2 + 1), "utf8"), /лимит/);
  assert.throws(() => encodeBody(Buffer.alloc(MAX_BODY_BYTES + 1).toString("base64"), "base64"), /лимит/);
  assert.deepEqual(buildOverride(original, draft({ body: largeBody })), {});
});
