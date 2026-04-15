import type {
  ContextPack,
  LaunchPlan,
  ProviderName,
  SessionRecord,
} from "@achbogga/latte-core";
import { renderPromptEnvelope, writeText } from "@achbogga/latte-core";

interface BuildProviderPlanInput {
  contextPack: ContextPack;
  outputDir: string;
  passthroughArgs: string[];
  prompt: string;
  promptFileName: string;
  session: SessionRecord;
}

function materializeTemplate(
  template: string[],
  promptFile: string,
  session: SessionRecord,
): string[] {
  return template.map((token) =>
    token
      .replaceAll("{{prompt_file}}", promptFile)
      .replaceAll("{{session_id}}", session.providerSessionId ?? session.id),
  );
}

export async function buildCodexLaunchPlan(
  input: BuildProviderPlanInput,
  argsTemplate: string[] = ["{{prompt_file}}"],
  command = "codex",
): Promise<LaunchPlan> {
  const promptText = renderPromptEnvelope(input.prompt, input.contextPack);
  const promptFile = `${input.outputDir}/${input.promptFileName}`;
  await writeText(promptFile, promptText);
  return {
    command: [
      command,
      ...materializeTemplate(argsTemplate, promptFile, input.session),
      ...input.passthroughArgs,
    ],
    promptFile,
    promptPreview: promptText.slice(0, 400),
    provider: "codex" satisfies ProviderName,
    session: input.session,
  };
}
