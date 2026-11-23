import { Type } from "typebox";
import type { ArtifactVersionCheck } from "../artifact/extension.js";
import { spacePreviewProblem, spaceRefProblem } from "../artifact/space.js";
import type { Environment } from "../host/types.js";
import { panelOfferProblem } from "../panel.js";
import { panelWidgetProperties, SpaceBody, SpaceMonitor } from "../protocol/panel.js";
import { ARTIFACT_REF } from "../protocol/send.js";
import { defineSendCard, type CardContribution } from "../send/tool.js";
import { monitorProblem } from "./monitor-contract.js";
import { contextMonitorConfigured } from "./source.js";

const MonitoredSpaceOffer = Type.Object({
  kind: Type.Literal("panel"),
  panel: Type.Object({ ...panelWidgetProperties, body: Type.Object({ ...SpaceBody.properties, monitor: SpaceMonitor }) }),
});

export function spaceSend(env: Environment, exists: ArtifactVersionCheck | undefined): CardContribution {
  const monitorConfigured = contextMonitorConfigured(env);
  return defineSendCard({
    schema: MonitoredSpaceOffer,
    instructions: [
      "For a Space powered by a web monitor, read artifact skill space-monitor. Offer it using body.kind space with monitor.url, monitor.goal and monitor.schema. The monitor starts when the user keeps the offer.",
      "For a [space-monitor] repair, send only the finished Space update card when the revision is ready.",
    ],
    async prepare(card) {
      const { id, body } = card.panel;
      const reserved = panelOfferProblem(id);
      if (reserved !== undefined) return { error: reserved };
      if (!monitorConfigured) return { error: "Context.dev monitoring is unavailable in this deployment." };
      const problem = monitorProblem(body.monitor) ?? spaceRefProblem(id, body.src) ?? spacePreviewProblem(id, body.preview);
      if (problem !== undefined) return { error: problem };
      if (exists === undefined) return { error: "Artifact storage is unavailable." };
      for (const ref of [body.src, body.preview]) {
        const match = ARTIFACT_REF.exec(ref);
        if (match === null || !await exists(match[1], Number(match[2]))) return { error: "Space artifact missing: " + ref };
      }
      return { card };
    },
  });
}
