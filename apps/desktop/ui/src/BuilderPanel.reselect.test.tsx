// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuilderPanel } from "./BuilderPanel.tsx";

afterEach(cleanup);

test("the load select resets after a pick, so the SAME definition can be reloaded", () => {
  const loads: string[] = [];
  render(<BuilderPanel onLoadDefinition={(n) => loads.push(n)} availableDefinitions={["acme", "meridian"]} />);
  const select = screen.getByLabelText("Open a saved definition") as HTMLSelectElement;

  // Pick "acme": fires the load, and the control resets to the placeholder.
  fireEvent.change(select, { target: { value: "acme" } });
  expect(loads).toEqual(["acme"]);
  expect(select.value).toBe("");

  // Re-select the SAME "acme": with the old uncontrolled select this fired
  // nothing (value unchanged); now it loads again.
  fireEvent.change(select, { target: { value: "acme" } });
  expect(loads).toEqual(["acme", "acme"]);
});
