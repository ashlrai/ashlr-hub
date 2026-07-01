/**
 * dispatch-run.tsx — "Dispatch Run" Raycast command.
 *
 * A Form that constructs and fires `ashlr run "<goal>" [--budget N] [--max-steps N] --json`
 * then shows the resulting run ID / status in a Detail view.
 *
 * The command is LOCAL-FIRST and BOUNDED — exactly like running `ashlr run`
 * from the terminal. No network calls are made by this command itself.
 */

import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Form,
  Icon,
  Toast,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useState } from "react";
import { runAshlrJson } from "./lib/ashlr-runner";

// ---------------------------------------------------------------------------
// Types — mirrors the JSON output of `ashlr run --json`
// ---------------------------------------------------------------------------

interface RunResult {
  id: string;
  goal: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  tokens?: number;
  estCostUsd?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Result detail view
// ---------------------------------------------------------------------------

function RunResultDetail({ result }: { result: RunResult }) {
  const statusColor =
    result.status === "done"
      ? "🟢"
      : result.status === "error" || result.status === "failed"
        ? "🔴"
        : "🟡";

  const costLine =
    result.estCostUsd != null
      ? `\n- **Est. cost:** $${result.estCostUsd.toFixed(4)}`
      : "";
  const tokensLine =
    result.tokens != null
      ? `\n- **Tokens:** ${result.tokens.toLocaleString()}`
      : "";
  const errorBlock = result.error
    ? `\n\n### Error\n\`\`\`\n${result.error}\n\`\`\``
    : "";

  const md = `# ${statusColor} Run dispatched

**ID:** \`${result.id}\`
**Goal:** ${result.goal}
**Status:** ${result.status}${tokensLine}${costLine}${errorBlock}

---
*Open the TUI (\`ashlr tui\`) or Runs view to monitor progress.*
`;

  return (
    <Detail
      navigationTitle={`Run · ${result.id}`}
      markdown={md}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard
            title="Copy Run Id"
            content={result.id}
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
          <Action.CopyToClipboard
            title="Copy Goal"
            content={result.goal}
            icon={Icon.Text}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Main form component
// ---------------------------------------------------------------------------

export default function DispatchRun() {
  const { push } = useNavigation();
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(values: {
    goal: string;
    budget: string;
    maxSteps: string;
  }) {
    const goal = values.goal.trim();
    if (!goal) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Goal is required",
      });
      return;
    }

    const args: string[] = ["run", goal, "--json"];

    const budget = parseFloat(values.budget);
    if (!isNaN(budget) && budget > 0) {
      args.push("--budget", String(budget));
    }

    const maxSteps = parseInt(values.maxSteps, 10);
    if (!isNaN(maxSteps) && maxSteps > 0) {
      args.push("--max-steps", String(maxSteps));
    }

    setIsLoading(true);
    await showToast({
      style: Toast.Style.Animated,
      title: "Dispatching run…",
      message: goal,
    });

    const result = await runAshlrJson<RunResult>(args, 120_000);
    setIsLoading(false);

    if (!result.ok || !result.data) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Run failed",
        message: result.error ?? "Unknown error",
      });
      return;
    }

    await showToast({
      style: Toast.Style.Success,
      title: "Run dispatched",
      message: `ID: ${result.data.id}`,
    });

    push(<RunResultDetail result={result.data} />);
  }

  return (
    <Form
      navigationTitle="Dispatch Run"
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Dispatch Run"
            icon={{ source: Icon.Play, tintColor: Color.Green }}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="goal"
        title="Goal"
        placeholder="e.g. Refactor the auth module to use JWT"
        info="The natural-language goal for this run. Passed verbatim to `ashlr run`."
        autoFocus
      />

      <Form.Separator />

      <Form.TextField
        id="budget"
        title="Budget (USD)"
        placeholder="e.g. 0.50 (optional)"
        info="Maximum spend in USD for this run. Leave blank for no cap."
      />

      <Form.TextField
        id="maxSteps"
        title="Max Steps"
        placeholder="e.g. 20 (optional)"
        info="Maximum number of agent steps. Leave blank for the default."
      />
    </Form>
  );
}
