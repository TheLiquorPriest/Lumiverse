import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { generateRoutes } from "./generate.routes";
import * as generateService from "../services/generate.service";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length > 0) spies.pop()!.mockRestore();
});

function authenticatedRoutes(userId: string): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("session", { user: { username: "owner" } } as never);
    await next();
  });
  app.route("/generate", generateRoutes);
  return app;
}

describe("generation Stop request authority", () => {
  test("routes an id-less correlated Stop before chat fallback and reports acceptance", async () => {
    const authorityId = crypto.randomUUID();
    const authorityStop = spyOn(generateService, "stopGenerationRequestAuthority")
      .mockResolvedValue(true);
    const chatStop = spyOn(generateService, "stopChatGenerations")
      .mockResolvedValue(false);
    spies.push(authorityStop, chatStop);

    const response = await authenticatedRoutes("user-a").request("/generate/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "chat-a", request_authority_id: authorityId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true, status: "accepted" });
    expect(authorityStop).toHaveBeenCalledWith("user-a", "chat-a", authorityId);
    expect(chatStop).toHaveBeenCalledWith("user-a", "chat-a");
  });
  test("passes owner chat authority to generation-id Stop", async () => {
    const exactStop = spyOn(generateService, "stopGeneration").mockResolvedValue(true);
    spies.push(exactStop);

    const response = await authenticatedRoutes("user-a").request("/generate/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation_id: "turn-a", chat_id: "chat-a" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true, status: "accepted" });
    expect(exactStop).toHaveBeenCalledWith("user-a", "turn-a", "chat-a");
  });
});
