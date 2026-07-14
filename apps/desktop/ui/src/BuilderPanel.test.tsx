// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BuilderPanel } from "./BuilderPanel.tsx";

afterEach(cleanup);

test("renders the form and shows validation until required fields are filled", () => {
  render(<BuilderPanel />);
  // Empty draft: the panel reports issues to fix.
  expect(screen.getByText(/issue\(s\) to fix/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "acme-assistant" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Acme Assistant" } });
  fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "You are governed." } });

  // Now valid — the status flips and the live harness.json reflects the edits.
  expect(screen.getByText(/Valid — ready to save/)).toBeTruthy();
  const manifest = screen.getByLabelText("harness.json preview");
  expect(manifest.textContent).toContain('"name": "acme-assistant"');
  expect(manifest.textContent).toContain('"displayName": "Acme Assistant"');
});

test("adding a rule updates the live policy.json preview", () => {
  render(<BuilderPanel />);
  fireEvent.click(screen.getByText("+ Add rule"));
  fireEvent.change(screen.getByLabelText("Rule 1 match"), { target: { value: "mcp__github__*" } });
  fireEvent.change(screen.getByLabelText("Rule 1 action"), { target: { value: "ask" } });

  const policy = screen.getByLabelText("policy.json preview");
  expect(policy.textContent).toContain('"match": "mcp__github__*"');
  expect(policy.textContent).toContain('"action": "ask"');
});

test("a bad accent surfaces a field-specific problem", () => {
  render(<BuilderPanel />);
  fireEvent.change(screen.getByLabelText("Accent"), { target: { value: "blue" } });
  const problems = screen.getByLabelText("Validation problems");
  expect(within(problems).getByText(/accent:/)).toBeTruthy();
});

test("the Back to chat control fires onClose", () => {
  let closed = false;
  render(<BuilderPanel onClose={() => (closed = true)} />);
  fireEvent.click(screen.getByText("Back to chat"));
  expect(closed).toBe(true);
});
