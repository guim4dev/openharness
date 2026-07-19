// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { BuilderPanel } from "./BuilderPanel.tsx";
import type { LoadedDefinition } from "./chat.ts";

afterEach(cleanup);

/**
 * Mirrors App's wiring: BuilderPanel is CONDITIONALLY mounted (view === "builder")
 * while `loadedDefinition` lives in the parent. `onLoadedApplied` is the one-shot
 * consume App wires to `clearLoadedDefinition` — without it, a remount re-applies
 * the stale definition over the fresh empty draft.
 */
function Harness({ loaded }: { loaded: LoadedDefinition }) {
  const [view, setView] = useState<"chat" | "builder">("builder");
  const [loadedDef, setLoadedDef] = useState<LoadedDefinition | undefined>(loaded);
  if (view !== "builder") {
    return (
      <button type="button" onClick={() => setView("builder")}>
        Build a harness again
      </button>
    );
  }
  return (
    <BuilderPanel
      onClose={() => setView("chat")}
      onLoadDefinition={() => {}}
      availableDefinitions={["acme"]}
      onLoadedApplied={() => setLoadedDef(undefined)}
      {...(loadedDef !== undefined ? { loadedDefinition: loadedDef } : {})}
    />
  );
}

test("a loaded definition is consumed once — remounting the builder starts blank, not stale", () => {
  const loaded: LoadedDefinition = {
    name: "acme",
    manifest: { name: "acme", branding: { displayName: "Acme", accent: "#4F46E5" } },
    systemPrompt: "You are Acme.",
  };

  render(<Harness loaded={loaded} />);

  // First mount: the loaded definition is folded in.
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("acme");

  // Back to chat (unmount), then build a harness again (remount).
  fireEvent.click(screen.getByText("Back to chat"));
  fireEvent.click(screen.getByText("Build a harness again"));

  // The stale definition was consumed on first apply, so the new session is blank.
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
});
