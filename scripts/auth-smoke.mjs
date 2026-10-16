import assert from "node:assert/strict";
import { build } from "../frontend/node_modules/esbuild/lib/main.js";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.window = new EventTarget();
const bundle = await build({ entryPoints: ["frontend/src/api.ts"], bundle: true, write: false, platform: "browser", format: "esm" });
const auth = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const accessKey = "modeldesk.access";
const refreshKey = "modeldesk.refresh";
const invalidToken = { detail: "Given token not valid for any token type", code: "token_not_valid" };
const respond = (config, data, status = 200) => {
  const response = { config, data, status, statusText: "", headers: {} };
  if (status >= 400) throw Object.assign(new Error(data.detail), { isAxiosError: true, config, response });
  return response;
};
storage.set(accessKey, "expired-memory-token");
storage.set(refreshKey, "valid-memory-refresh");
let refreshes = 0;
let uploads = 0;
auth.api.defaults.adapter = async (config) => {
  if (config.url === "/auth/refresh/") {
    refreshes++;
    return respond(config, { access: "fresh-memory-token" });
  }
  if (config.headers.Authorization !== "Bearer fresh-memory-token") return respond(config, invalidToken, 401);
  if (config.url === "/files/upload/") {
    uploads++;
    assert.equal(config.data.get("target_format"), "glb");
    assert.equal(await config.data.get("file").text(), "v 0 0 0\n");
    return respond(config, { id: "memory-task", status: "queued" }, 201);
  }
  return respond(config, []);
};
const results = await Promise.allSettled([
  auth.uploadTask(new File(["v 0 0 0\n"], "model.obj"), "glb"),
  auth.listTasks(),
  auth.listSourceFiles(),
]);
const failed = results.find((result) => result.status === "rejected");
assert.equal(failed?.reason?.response?.data?.detail, undefined, `Conversion failed: ${failed?.reason?.response?.data?.detail}`);
assert.ok(results.every((result) => result.status === "fulfilled"));
assert.equal(refreshes, 1, "Concurrent requests must share one refresh");
assert.equal(uploads, 1, "Only one authenticated conversion may be submitted");
assert.equal(storage.get(accessKey), "fresh-memory-token");
console.log("PASS: expired access token refreshes once and conversion upload resumes.");

let expirations = 0;
window.addEventListener(auth.AUTH_EXPIRED_EVENT, () => expirations++);
const reset = () => {
  auth.logout();
  storage.set(accessKey, "expired-memory-token");
  storage.set(refreshKey, "valid-memory-refresh");
};
reset();
refreshes = 0;
auth.api.defaults.adapter = async (config) => {
  if (config.url === "/auth/refresh/") {
    refreshes++;
    assert.equal(config.headers.Authorization, undefined, "Refresh must not carry the expired access token");
    await new Promise((resolve) => setTimeout(resolve, 5));
    return respond(config, invalidToken, 401);
  }
  return respond(config, invalidToken, 401);
};
await Promise.all([assert.rejects(auth.listTasks()), assert.rejects(auth.listSourceFiles())]);
assert.equal(refreshes, 1);
assert.equal(expirations, 1, "An invalid refresh must expire the session once");
assert.equal(storage.get(accessKey), undefined);
assert.equal(storage.get(refreshKey), undefined);
console.log("PASS: invalid refresh expires the session without looping.");

reset();
storage.delete(refreshKey);
await assert.rejects(auth.listTasks());
assert.equal(storage.get(accessKey), undefined);
assert.equal(expirations, 2);

reset();
let attempts = 0;
auth.api.defaults.adapter = async (config) => {
  attempts++;
  if (config.url === "/auth/refresh/") return respond(config, { access: "still-rejected" });
  return respond(config, invalidToken, 401);
};
await assert.rejects(auth.listTasks());
assert.equal(attempts, 3, "A refreshed request may retry only once");
assert.equal(expirations, 3);
console.log("PASS: missing refresh and repeated 401 require sign-in with bounded retries.");

reset();
auth.api.defaults.adapter = async (config) => {
  if (config.url === "/auth/refresh/") return respond(config, { detail: "Temporary outage" }, 503);
  return respond(config, invalidToken, 401);
};
await assert.rejects(auth.listTasks());
assert.equal(storage.get(refreshKey), "valid-memory-refresh");
assert.equal(expirations, 3, "A server outage must not log out the user");
auth.api.defaults.adapter = async (config) => respond(config, { detail: "Network unavailable" }, 500);
await assert.rejects(auth.listTasks());
assert.equal(expirations, 3);
console.log("PASS: temporary server failures preserve the session.");

reset();
auth.api.defaults.adapter = async (config) => {
  assert.notEqual(config.url, "/auth/refresh/", "Login failures must not trigger refresh");
  assert.equal(config.headers.Authorization, undefined);
  return respond(config, { detail: "Invalid credentials" }, 401);
};
await assert.rejects(auth.login("memory@example.com", "wrong-memory-password"));
assert.equal(expirations, 3);
assert.equal(storage.get(refreshKey), "valid-memory-refresh");
console.log("PASS: public login failures bypass session refresh.");

reset();
let finishRefresh;
const startedRefresh = Promise.withResolvers();
auth.api.defaults.adapter = async (config) => {
  if (config.url === "/auth/refresh/") {
    startedRefresh.resolve();
    await new Promise((resolve) => { finishRefresh = resolve; });
    return respond(config, { access: "late-memory-token" });
  }
  return respond(config, invalidToken, 401);
};
const afterLogout = assert.rejects(auth.listTasks());
await startedRefresh.promise;
auth.logout();
finishRefresh();
await afterLogout;
assert.equal(storage.get(accessKey), undefined, "A late refresh must not restore a logged-out session");
assert.equal(expirations, 3);
console.log("PASS: in-flight refresh cannot restore a logged-out session.");

reset();
refreshes = 0;
let releaseStale;
const staleRequested = Promise.withResolvers();
auth.api.defaults.adapter = async (config) => {
  if (config.url === "/auth/refresh/") {
    refreshes++;
    return respond(config, { access: "fresh-memory-token", refresh: "rotated-memory-refresh" });
  }
  if (config.url === "/files/" && config.headers.Authorization !== "Bearer fresh-memory-token") {
    staleRequested.resolve();
    await new Promise((resolve) => { releaseStale = resolve; });
    return respond(config, invalidToken, 401);
  }
  return respond(config, config.headers.Authorization === "Bearer fresh-memory-token" ? [] : invalidToken,
    config.headers.Authorization === "Bearer fresh-memory-token" ? 200 : 401);
};
const stale = auth.listSourceFiles();
await staleRequested.promise;
await auth.listTasks();
releaseStale();
await stale;
assert.equal(refreshes, 1, "A late 401 must use the already refreshed token");
assert.equal(storage.get(refreshKey), "rotated-memory-refresh");
console.log("PASS: delayed 401 uses the refreshed token, including refresh rotation.");
