import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveTaskboardTheme,
  themeFromHostMessage,
} from "../web/src/theme.mjs";

test("embedded host theme wins over system and query", () => {
  assert.equal(resolveTaskboardTheme({
    embedded: true,
    hostTheme: "dark",
    queryTheme: "light",
    systemDark: false,
  }), "dark");
});

test("standalone query is a test override", () => {
  assert.equal(resolveTaskboardTheme({
    embedded: false,
    hostTheme: null,
    queryTheme: "dark",
    systemDark: false,
  }), "dark");
});

test("invalid or absent input falls back to system then light", () => {
  assert.equal(resolveTaskboardTheme({
    embedded: true,
    hostTheme: "sepia",
    queryTheme: null,
    systemDark: true,
  }), "dark");
  assert.equal(resolveTaskboardTheme({
    embedded: true,
    hostTheme: null,
    queryTheme: null,
    systemDark: false,
  }), "light");
});

test("reads both supported upstream host messages", () => {
  assert.equal(themeFromHostMessage({ type: "taskboard:theme", theme: "dark" }), "dark");
  assert.equal(themeFromHostMessage({ type: "taskboard:host-context", payload: { theme: "light" } }), "light");
  assert.equal(themeFromHostMessage({ type: "taskboard:theme", theme: "sepia" }), null);
});
