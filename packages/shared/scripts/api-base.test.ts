import assert from "node:assert/strict";
import { test } from "node:test";
import { kidDevProxy, localAssetUrl, resolveKidApiBase } from "./api-base.ts";

test("local mode ignores an absolute hosted API origin", () => {
  assert.equal(resolveKidApiBase("https://api.wainwright.fun", true), "");
  assert.equal(resolveKidApiBase("https://api.wainwright.fun/", true), "");
  assert.equal(resolveKidApiBase("/api", true), "/api");
  assert.equal(resolveKidApiBase("", true), "");
  assert.equal(resolveKidApiBase(undefined, true), "");
});

test("hosted mode keeps the configured origin, including empty", () => {
  assert.equal(resolveKidApiBase("https://api.wainwright.fun", false), "https://api.wainwright.fun");
  assert.equal(resolveKidApiBase(undefined, false), "");
});

test("local icons and kid config leave the hosted host", () => {
  assert.equal(localAssetUrl("/app-icons/1.jpg", "", true), "/app-icons/1.jpg");
  assert.equal(
    localAssetUrl("https://api.wainwright.fun/app-icons/1.jpg", "", true),
    "/app-icons/1.jpg",
  );
  assert.equal(
    localAssetUrl("https://hannah.wainwright.fun/website-icons/ha.png", "", true),
    "/website-icons/ha.png",
  );
  assert.equal(
    localAssetUrl("https://api.wainwright.fun/kid/config", "", true),
    "/kid/config",
  );
  assert.equal(localAssetUrl("https://homeassistant.local/", "", true), "https://homeassistant.local/");
  assert.equal(
    localAssetUrl("https://apps.apple.com/gb/app/maths/id111", "", true),
    "https://apps.apple.com/gb/app/maths/id111",
  );
});

test("dev proxy stays on the hosted API unless a local host is named", () => {
  assert.deepEqual(kidDevProxy({}), { target: "https://api.wainwright.fun", changeOrigin: true });
  assert.deepEqual(kidDevProxy({ KID_API_PROXY: "http://127.0.0.1:43127", KID_API_PROXY_HOST: "wainwright.fun" }), {
    target: "http://127.0.0.1:43127",
    changeOrigin: false,
    headers: { host: "wainwright.fun", "x-real-ip": "192.168.1.182" },
  });
});

test("hosted mode does not rewrite absolute icon URLs", () => {
  const hosted = "https://api.wainwright.fun/app-icons/1.jpg";
  assert.equal(localAssetUrl(hosted, "", false), hosted);
  assert.equal(localAssetUrl("/app-icons/1.jpg", "https://api.wainwright.fun", false), "https://api.wainwright.fun/app-icons/1.jpg");
});
