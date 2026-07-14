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

test("adding a skill and an MCP server flows into the live harness.json", () => {
  render(<BuilderPanel />);
  fireEvent.click(screen.getByText("+ Add skill"));
  fireEvent.change(screen.getByLabelText("Skill 1 path"), { target: { value: "skills/triage" } });

  fireEvent.click(screen.getByText("+ Add MCP server"));
  fireEvent.change(screen.getByLabelText("MCP 1 name"), { target: { value: "github" } });
  fireEvent.change(screen.getByLabelText("MCP 1 command"), { target: { value: "npx -y srv@1.2.3" } });

  const manifest = screen.getByLabelText("harness.json preview");
  expect(manifest.textContent).toContain('"path": "skills/triage"');
  expect(manifest.textContent).toContain('"github"');
  expect(manifest.textContent).toContain('"transport": "stdio"');
});

test("switching an MCP server to http swaps the command field for a url field", () => {
  render(<BuilderPanel />);
  fireEvent.click(screen.getByText("+ Add MCP server"));
  // stdio by default -> a command field is shown.
  expect(screen.getByLabelText("MCP 1 command")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("MCP 1 transport"), { target: { value: "http" } });
  // now a url field replaces it.
  expect(screen.getByLabelText("MCP 1 url")).toBeTruthy();
});

test("the Back to chat control fires onClose", () => {
  let closed = false;
  render(<BuilderPanel onClose={() => (closed = true)} />);
  fireEvent.click(screen.getByText("Back to chat"));
  expect(closed).toBe(true);
});

test("Save & verify is disabled until the draft is valid, then fires onSave with the files", () => {
  const calls: { name: string; manifest: unknown; policy: unknown; systemPrompt: string }[] = [];
  render(<BuilderPanel onSave={(input) => calls.push(input)} canSave />);

  const btn = screen.getByText("Save & verify") as HTMLButtonElement;
  expect(btn.disabled).toBe(true); // empty draft is invalid

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "acme-assistant" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Acme Assistant" } });
  fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "You are governed." } });

  expect(btn.disabled).toBe(false);
  fireEvent.click(btn);
  expect(calls).toHaveLength(1);
  expect(calls[0].name).toBe("acme-assistant");
  expect((calls[0].manifest as { name: string }).name).toBe("acme-assistant");
  expect(calls[0].systemPrompt).toBe("You are governed.");
});

test("the save button shows 'Connecting…' and stays disabled when not connected", () => {
  render(<BuilderPanel onSave={() => {}} canSave={false} />);
  const btn = screen.getByText("Connecting…") as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
});

test("a save result is surfaced", () => {
  render(
    <BuilderPanel
      onSave={() => {}}
      canSave
      saveResult={{ ok: true, dir: "/cfg/definitions/acme", problems: [] }}
    />,
  );
  expect(screen.getByText(/Saved to \/cfg\/definitions\/acme — doctor OK/)).toBeTruthy();
});

test("no save affordance when onSave is not provided", () => {
  render(<BuilderPanel />);
  expect(screen.queryByText("Save & verify")).toBeNull();
});
