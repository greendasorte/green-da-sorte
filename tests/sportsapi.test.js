const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const nativeFetch = global.fetch;

process.env.SPORTSAPI_API_KEY = "test_sportsapi_key";
const sportsApiRouter = require("../sportsapi");

function startTestServer(t) {
  const app = express();
  app.use("/api/sportsapi", sportsApiRouter);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return new Promise(resolve => server.once("listening", () => {
    const address = server.address();
    resolve("http://127.0.0.1:" + address.port);
  }));
}

test("games/filter forwards the documented query and keeps the API key server-side", async t => {
  const originalFetch = global.fetch;
  let requestedUrl = "";
  let requestedHeaders = {};
  global.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestedHeaders = options.headers || {};
    return new Response(JSON.stringify({ matches: [{ id: "match-1", status: "scheduled" }], total: 1 }), {
      status: 200,
      headers: { "content-type": "application/json", "ratelimit-remaining": "59" }
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const base = await startTestServer(t);
  const response = await nativeFetch(base + "/api/sportsapi/games/filter?sport=football&date=2026-11-09&statusIn=scheduled,live&limit=10");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.matches[0].id, "match-1");
  assert.match(requestedUrl, /\/games\/filter\?/);
  assert.match(requestedUrl, /statusIn=scheduled%2Clive/);
  assert.equal(requestedHeaders["X-API-Key"], "test_sportsapi_key");
  assert.equal(response.headers.get("ratelimit-remaining"), "59");
});

test("games/filter rejects invalid dates before contacting the provider", async t => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error("provider should not be called"); };
  t.after(() => { global.fetch = originalFetch; });

  const base = await startTestServer(t);
  const response = await nativeFetch(base + "/api/sportsapi/games/filter?date=09-11-2026");
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("games/:id/odds proxies the requested match id", async t => {
  const originalFetch = global.fetch;
  let requestedUrl = "";
  global.fetch = async url => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ matchId: "match-odds", markets: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const base = await startTestServer(t);
  const response = await nativeFetch(base + "/api/sportsapi/games/match-odds/odds?sport=football");
  assert.equal(response.status, 200);
  assert.match(requestedUrl, /\/games\/match-odds\/odds\?sport=football/);
  assert.equal((await response.json()).matchId, "match-odds");
});
