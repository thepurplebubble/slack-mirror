import { Elysia } from "elysia";
import { SlackAPIClient, SlackApp } from "slack-edge";
import { t } from "./lib/templates";

import { indexEndpoint } from "./endpoints";
import { healthEndpoint } from "./endpoints/health";
import { blog } from "./util/Logger";

const app = new SlackApp({
  env: {
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN!,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET!,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN!,
    SLACK_LOGGING_LEVEL: "INFO",
  },
  startLazyListenerAfterAck: true,
});

const elysia = new Elysia()
  .get("/", indexEndpoint)
  .get("/ping", healthEndpoint)
  .get("/up", healthEndpoint)
  .listen(process.env.ELYSIA_PORT || 3001);

export default {
  port: process.env.SLACK_PORT || 3000,
  async fetch(request: Request) {
    return await app.run(request);
  },
};

let env = process.env.NODE_ENV;
// slog(t("app.startup", { environment: env }), "info");
blog(t("app.startup", { environment: env }), "start");

const client: SlackAPIClient = app.client;
export { app, client };
