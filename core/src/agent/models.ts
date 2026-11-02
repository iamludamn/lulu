import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { ModelRef as DurableModelRef } from "@earendil-works/pi-durable";
import type { Environment } from "../host/types.js";
import type { ModelConfig, ModelRef } from "../protocol/contract.js";

const DEFAULT_MODEL: ModelRef = { provider: "opencode-go", id: "deepseek-v4.1-flash" };

function parseModel(raw: string | undefined): ModelRef | undefined {
  const text = (raw ?? "").trim();
  const slash = text.indexOf("/");
  if (slash <= 0) return undefined;
  return { provider: text.slice(0, slash), id: text.slice(slash + 1) };
}

export const durableModel = (ref: ModelRef): DurableModelRef => ({ provider: ref.provider, modelId: ref.id });

export function createChatModels(env: Environment): Models {
  const models = createModels({
    authContext: {
      env: async (name) => {
        const value: unknown = Reflect.get(env, name);
        return typeof value === "string" && value.length > 0 ? value : undefined;
      },
      fileExists: async () => false,
    },
  });
  models.setProvider(openaiProvider());
  models.setProvider(opencodeGoProvider());
  return models;
}

export function chatModelRef(env: Environment, selected: ModelRef | undefined): DurableModelRef {
  return durableModel(parseModel(env.LULU_MODEL) ?? selected ?? DEFAULT_MODEL);
}

export async function chatModelConfig(models: Models, env: Environment, selected: ModelRef | undefined): Promise<ModelConfig> {
  const available = (await models.getAvailable()).map(({ provider, id }) => ({ provider, id }));
  const chosen = available.find((model) => model.provider === selected?.provider && model.id === selected?.id) ?? null;
  return { model: chosen, overridden: parseModel(env.LULU_MODEL) !== undefined, models: available };
}
