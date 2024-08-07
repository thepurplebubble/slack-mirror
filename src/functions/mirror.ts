import {
  AnyMessageBlock,
  BotMessageEvent,
  ChatPostMessageRequest,
  FileShareMessageEvent,
  GenericMessageEvent,
  MessageChangedEvent,
  MessageDeletedEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  SlackAPIClient,
  ThreadBroadcastMessageEvent,
} from "slack-edge";
import { channelMap, enabledChannels, hcTeam, pbTeam } from "../config";
import { getEnabled, prisma } from "../index";
import { blog, slog } from "../util/Logger";

let team: string;

export function hasChannel(channel: string): boolean {
  // check all keys and values in the channelMap for the channel
  for (const key in channelMap) {
    if (channelMap[key] === channel || key === channel) {
      return true;
    }
  }

  return false;
}

export async function mirror(
  pbClient: SlackAPIClient,
  hcClient: SlackAPIClient,
  message:
    | (GenericMessageEvent & { team?: string })
    | (BotMessageEvent & { team?: string })
    | (FileShareMessageEvent & { team?: string })
    | (ThreadBroadcastMessageEvent & { team?: string })
) {
  try {
    if (!getEnabled()) {
      return slog("Mirror is not enabled", "info");
    }

    if (!hasChannel(message.channel)) {
      return slog(`Channel not mapped: ${message.channel}`, "info");
    }

    if (!enabledChannels.includes(message.channel)) {
      return slog(
        `Channel not in the list of enabled channels: ${message.channel}`,
        "info"
      );
    }

    if (
      message.team === pbTeam ||
      // @ts-expect-error
      (message.files && message.files[0].user_team === pbTeam)
    ) {
      team = "PB";
    } else if (
      message.team === hcTeam ||
      // @ts-expect-error
      (message.files && message.files[0].user_team === hcTeam)
    ) {
      team = "HC";
    } else {
      team = "Unknown";
    }

    if (
      message.subtype === "bot_message" ||
      // @ts-expect-error
      message.subtype === "channel_join" ||
      // @ts-expect-error
      message.subtype === "channel_leave" ||
      // @ts-expect-error
      message.subtype === "channel_archive" ||
      // @ts-expect-error
      message.subtype === "channel_unarchive" ||
      // @ts-expect-error
      message.subtype === "channel_topic" ||
      // @ts-expect-error
      message.subtype === "channel_purpose" ||
      // @ts-expect-error
      message.subtype === "channel_name"
    ) {
      return;
    }

    if (!channelMap[message.channel]) {
      return;
    }

    blog(`Message received from team ${team}`, "info");

    // @ts-expect-error
    let messageTeam = message.team! ?? message.files[0].user_team!;
    let messageChannel = message.channel!;
    let userProfile;

    if (messageTeam === pbTeam) {
      userProfile = await pbClient.users.profile.get({
        user: message.user,
      });
    } else if (messageTeam === hcTeam) {
      userProfile = await hcClient.users.profile.get({
        user: message.user,
      });
    }

    let profile = userProfile.profile!;
    let userpfp = profile.image_512!;
    let userDisplayName = profile.display_name!;

    // console.log("User profile: ", profile);

    let dbUser = await prisma.user.findFirst({
      where: {
        id: message.user,
      },
    });

    if (!dbUser) {
      await prisma.user.create({
        data: {
          id: message.user,
          name: profile.real_name,
          displayName: userDisplayName,
          image: userpfp,
          team: messageTeam,
        },
      });
    }

    let sendingMessage: ChatPostMessageRequest | null = null;

    const fileBlocks: AnyMessageBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "\n",
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Files:*\n${
            // @ts-expect-error
            message.files
              ? // @ts-expect-error
                message.files
                  .map((file) => `<${file.url_private}|${file.name}>`)
                  .join(", ")
              : ""
          }`,
        },
      },
    ];

    // Check if the message is sent in a thread
    if (message.thread_ts) {
      console.log("Thread broadcast message received");

      let threadTs = message.thread_ts;
      let originMessage: {
        user: string;
        originTs: string;
        originChannel: string;
        mirrorTs: string;
        mirrorChannel: string;
      } | null = null;

      // @ts-expect-error
      originMessage = await prisma.message.findFirst({
        where: {
          originTs: threadTs,
          originChannel: messageChannel,
        },
      });

      if (!originMessage) {
        return;
      }

      sendingMessage = {
        thread_ts: originMessage.originTs,
        channel: channelMap[messageChannel],
        username: userDisplayName,
        icon_url: userpfp,
        text: message.text,
        // @ts-expect-error
        blocks: message.files
          ? [...(message.blocks ?? []), ...fileBlocks]
          : message.blocks,
        unfurl_links: true,
        unfurl_media: true,
      };
    }
    const day = new Date().toISOString().split("T")[0] + "T00:00:00.000Z";

    if (sendingMessage) {
      if (messageTeam === hcTeam) {
        await pbClient.chat.postMessage(sendingMessage);
      } else if (messageTeam === pbTeam) {
        await hcClient.chat.postMessage(sendingMessage);
      }

      await prisma.analytics.upsert({
        where: {
          day: day,
        },
        update: {
          totalSyncedMessages: {
            increment: 1,
          },
        },
        create: {
          day: day,
          newThreads: 0,
          totalSyncedMessages: 1,
        },
      });
    } else {
      blog(`Creating a new top level message`, "info");

      if (messageTeam === hcTeam) {
        // send a new message
        const newMessage = await pbClient.chat.postMessage({
          channel: channelMap[messageChannel],
          username: userDisplayName,
          icon_url: userpfp,
          text: message.text,
          // @ts-expect-error
          blocks: message.files
            ? [...(message.blocks ?? []), ...fileBlocks]
            : message.blocks,
          unfurl_links: true,
          unfurl_media: true,
        });

        let dbUser = await prisma.user.findFirst({
          where: {
            id: message.user,
          },
        });

        if (!dbUser) {
          await prisma.user.create({
            data: {
              id: message.user,
              name: profile.real_name,
              displayName: userDisplayName,
              image: userpfp,
              team: messageTeam,
            },
          });
        }

        await prisma.message.create({
          data: {
            user: {
              connect: {
                id: message.user,
              },
            },
            originTs: message.ts,
            originChannel: messageChannel,
            originTeam: messageTeam,
            mirrorTs: newMessage.ts!,
            mirrorChannel: channelMap[messageChannel],
            mirrorTeam: pbTeam,
          },
        });
      } else if (messageTeam === pbTeam) {
        // send a new message
        const newMessage = await hcClient.chat.postMessage({
          channel: channelMap[messageChannel],
          username: userDisplayName,
          icon_url: userpfp,
          text: message.text,
          // @ts-expect-error
          blocks: message.files
            ? [...(message.blocks ?? []), ...fileBlocks]
            : message.blocks,
          unfurl_links: true,
          unfurl_media: true,
        });

        await prisma.message.create({
          data: {
            user: {
              connectOrCreate: {
                where: { id: message.user },
                create: {
                  id: message.user,
                  name: userProfile.profile.real_name,
                  displayName: userDisplayName,
                  image: userpfp,
                  team: messageTeam,
                },
              },
            },
            originTs: message.ts,
            originChannel: messageChannel,
            originTeam: messageTeam,
            mirrorTs: newMessage.ts!,
            mirrorChannel: channelMap[messageChannel],
            mirrorTeam: hcTeam,
          },
        });
      }

      await prisma.analytics.upsert({
        where: {
          day: day,
        },
        update: {
          newThreads: {
            increment: 1,
          },
        },
        create: {
          day: day,
          newThreads: 1,
          totalSyncedMessages: 0,
        },
      });
    }
  } catch (error) {
    blog(`Error responding to message: ${error}`, "error");
  }
}

export async function updateMessage(
  pbClient: SlackAPIClient,
  hcClient: SlackAPIClient,
  message: MessageChangedEvent
) {
  try {
    if (!getEnabled()) {
      return;
    }

    if (!hasChannel(message.channel)) {
      return;
    }

    // @ts-expect-error
    if (message.previous_message.thread_ts) {
      return;
    }

    if (
      // @ts-expect-error
      message.message.team! === pbTeam
    ) {
      team = "PB";
    } else if (
      // @ts-expect-error
      message.message.team! === hcTeam
    ) {
      team = "HC";
    } else {
      team = "Unknown";
    }

    if (message.message.subtype === "bot_message") {
      return;
    }

    if (!channelMap[message.channel]) {
      return;
    }

    blog(`Message received from team ${team} to be updated`, "info");

    // @ts-expect-error
    let messageTeam = message.message.team!;
    let messageChannel = message.channel!;

    const dbMessage = await prisma.message.findFirst({
      where: {
        originChannel: messageChannel,
        originTs: message.message.ts,
      },
    });

    await prisma.message.update({
      where: {
        originChannel: messageChannel,
        originTs: message.message.ts,
      },
      data: {
        updated: true,
      },
    });

    if (messageTeam === hcTeam) {
      await pbClient.chat.update({
        channel: channelMap[messageChannel],
        ts: dbMessage!.originTs,
        // @ts-expect-error
        text: message.message.text,
        // @ts-expect-error
        blocks: message.message.blocks,
      });
    } else if (messageTeam === pbTeam) {
      await hcClient.chat.update({
        channel: channelMap[messageChannel],
        ts: dbMessage!.originTs,
        // @ts-expect-error
        text: message.message.text,
        // @ts-expect-error
        blocks: message.message.blocks,
      });
    }
  } catch (error) {
    blog(`Error updating message: ${error}`, "error");
  }
}

export async function deleteMessage(
  pbClient: SlackAPIClient,
  hcClient: SlackAPIClient,
  message: MessageDeletedEvent
) {
  try {
    if (!getEnabled()) {
      return;
    }

    if (!hasChannel(message.channel)) {
      return;
    }

    // @ts-expect-error
    if (message.previous_message.thread_ts) {
      return;
    }

    if (
      // @ts-expect-error
      message.previous_message.team === pbTeam
    ) {
      team = "PB";
    } else if (
      // @ts-expect-error
      message.previous_message.team === hcTeam
    ) {
      team = "HC";
    } else {
      team = "Unknown";
    }

    if (message.previous_message.subtype === "bot_message") {
      return;
    }

    if (!channelMap[message.channel]) {
      return;
    }

    blog(`Message received from team ${team} to be deleted`, "info");

    // @ts-expect-error
    let messageTeam = message.previous_message.team;
    let messageChannel = message.channel;

    const dbMessage = await prisma.message.findFirst({
      where: {
        originTs: message.previous_message.ts,
        originChannel: messageChannel,
      },
    });

    await prisma.message.update({
      where: {
        originTs: message.previous_message.ts,
        originChannel: messageChannel,
      },
      data: {
        deleted: true,
      },
    });

    if (messageTeam === hcTeam) {
      await pbClient.chat.delete({
        channel: channelMap[messageChannel],
        ts: dbMessage!.originTs,
      });
    } else if (messageTeam === pbTeam) {
      await hcClient.chat.delete({
        channel: channelMap[messageChannel],
        ts: dbMessage!.originTs,
      });
    }
  } catch (error) {
    blog(`Error deleting message: ${error}`, "error");
  }
}

export async function messageReact(
  pbClient: SlackAPIClient,
  hcClient: SlackAPIClient,
  event: ReactionAddedEvent
) {
  try {
    console.log("Reaction added event received");
    console.log(event);

    if (!getEnabled()) {
      return;
    }

    if (!hasChannel(event.item.channel)) {
      return;
    }

    if (!channelMap[event.item.channel]) {
      return;
    }

    // get message from db
    const dbMessage = await prisma.message.findFirst({
      where: {
        OR: [
          {
            originTs: event.item.ts,
            originChannel: event.item.channel,
          },
          {
            mirrorTs: event.item.ts,
            mirrorChannel: event.item.channel,
          },
        ],
      },
    });

    if (!dbMessage) {
      console.log("Message not found in the database");
      return;
    }

    console.log("DB Message: ", dbMessage);

    blog(`Reaction received from team ${team}`, "info");
  } catch (error) {
    blog(`Error responding to reaction: ${error}`, "error");
  }
}

export async function messageUnreact(
  pbClient: SlackAPIClient,
  hcClient: SlackAPIClient,
  event: ReactionRemovedEvent
) {
  try {
    console.log("Reaction removed event received");
    console.log(event);
  } catch (error) {
    blog(`Error responding to reaction: ${error}`, "error");
  }
}
