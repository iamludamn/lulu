import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";

const ref = (process.env.MEMORY_MODEL ?? "opencode-go/deepseek-v4.1-flash").split("/");

export const models = createModels({
  authContext: {
    env: async (name) => process.env[name] || undefined,
    fileExists: async () => false,
  },
});
models.setProvider(openaiProvider());
models.setProvider(opencodeGoProvider());

export const memoryModelRef = () => ({ provider: ref[0], modelId: ref.slice(1).join("/") });
