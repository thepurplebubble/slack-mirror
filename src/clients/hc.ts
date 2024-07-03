import { SlackApp } from "slack-edge";

const isdev = process.env.NODE_ENV === "development";

const HCapp = new SlackApp({
  env: {
    SLACK_BOT_TOKEN: process.env.HC_SLACK_BOT_TOKEN!,
    SLACK_APP_TOKEN: process.env.HC_SLACK_APP_TOKEN!,
    SLACK_SIGNING_SECRET: process.env.HC_SLACK_SIGNING_SECRET!,
    SLACK_LOGGING_LEVEL: isdev ? "DEBUG" : "INFO",
  },
});

export { HCapp };

export default {
  port: 3000,
  async fetch(request: Request) {
    return await HCapp.run(request);
  },
};
