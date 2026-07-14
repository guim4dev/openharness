import { expect, test } from "vitest";
import { globMatch } from "./glob.ts";

test("* matches any run including empty", () => {
  expect(globMatch("*", "anything")).toBe(true);
  expect(globMatch("git *", "git status")).toBe(true);
  expect(globMatch("git *", "git ")).toBe(true);
  expect(globMatch("git *", "gitx")).toBe(false);
  expect(globMatch("mcp__*__delete_*", "mcp__linear__delete_issue")).toBe(true);
});

test("? matches exactly one character", () => {
  expect(globMatch("gp?", "gp5")).toBe(true);
  expect(globMatch("gp?", "gp")).toBe(false);
});

test("anchors the whole string", () => {
  expect(globMatch("read", "read")).toBe(true);
  expect(globMatch("read", "read_file")).toBe(false);
  expect(globMatch("read", "xread")).toBe(false);
});

test("regex metacharacters are matched literally", () => {
  expect(globMatch("a.b", "a.b")).toBe(true);
  expect(globMatch("a.b", "axb")).toBe(false);
  expect(globMatch("cost+", "cost+")).toBe(true);
});

test("dot spans newlines (multi-line commands)", () => {
  expect(globMatch("bash*", "bash")).toBe(true);
  expect(globMatch("git *", "git commit -m 'line1\nline2'")).toBe(true);
});

test("case-insensitive opt-in matches regardless of case; default stays case-sensitive", () => {
  // default: case-sensitive
  expect(globMatch("*DELETE*", "delete from orders")).toBe(false);
  expect(globMatch("*DELETE*", "DELETE FROM orders")).toBe(true);
  // opt-in: case-insensitive
  expect(globMatch("*DELETE*", "delete from orders", true)).toBe(true);
  expect(globMatch("*DELETE*", "Delete From Orders", true)).toBe(true);
  // substring across newlines (canonical arg string joins fields with \n)
  expect(globMatch("*DROP*", "SELECT 1\ndrop table x", true)).toBe(true);
});
