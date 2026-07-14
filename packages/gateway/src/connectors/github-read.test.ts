import { expect, test } from "vitest";
import { createGithubReadConnector } from "./github-read.ts";

interface Rec {
  url?: string;
  init?: RequestInit;
}

function fakeResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function stubFetch(rec: Rec, res: Response): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    rec.url = String(url);
    rec.init = init;
    return res;
  }) as unknown as typeof fetch;
}

test("list_issues calls the GitHub API with the bearer cred and returns the body", async () => {
  const rec: Rec = {};
  const conn = createGithubReadConnector(stubFetch(rec, fakeResponse('[{"number":1,"title":"a bug"}]')));
  const res = await conn.call("github__list_issues", { owner: "acme", repo: "app" }, { secret: "ghp_x" });

  expect(res.isError).toBeUndefined();
  expect(rec.url).toBe("https://api.github.com/repos/acme/app/issues");
  expect((rec.init?.headers as Record<string, string>).authorization).toBe("Bearer ghp_x");
  expect(res.content[0].text).toContain("a bug");
});

test("get_issue targets the numbered issue path", async () => {
  const rec: Rec = {};
  const conn = createGithubReadConnector(stubFetch(rec, fakeResponse("{}")));
  await conn.call("github__get_issue", { owner: "o", repo: "r", number: 42 }, { secret: "t" });
  expect(rec.url).toBe("https://api.github.com/repos/o/r/issues/42");
});

test("a non-ok upstream is an error result (upstream body not echoed)", async () => {
  const conn = createGithubReadConnector(stubFetch({}, fakeResponse("secret-ish 404 body", 404)));
  const res = await conn.call("github__list_issues", { owner: "a", repo: "b" }, { secret: "t" });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).not.toContain("secret-ish");
});

test("missing owner/repo is refused WITHOUT any upstream call", async () => {
  let called = false;
  const conn = createGithubReadConnector((async () => {
    called = true;
    return fakeResponse("x");
  }) as unknown as typeof fetch);
  const res = await conn.call("github__list_issues", {}, { secret: "t" });
  expect(res.isError).toBe(true);
  expect(called).toBe(false);
});

test("declares exactly the two read tools", () => {
  const conn = createGithubReadConnector(stubFetch({}, fakeResponse("x")));
  expect(conn.tools.map((t) => t.name)).toEqual(["github__list_issues", "github__get_issue"]);
});
