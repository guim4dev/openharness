import { expect, test } from "vitest";
import { ping } from "./index.ts";

test("toolchain runs and imports resolve", () => {
  expect(ping()).toBe("pong");
});
