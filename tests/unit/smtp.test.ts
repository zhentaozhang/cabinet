import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { sendEmail, smtpConfigFromEnv } from "@/lib/connectors/email";

/**
 * A fake SMTP server: enough of the protocol to prove the client speaks it,
 * and to prove a rejection is reported instead of swallowed.
 */
type Fake = {
  port: number;
  transcript: string[];
  close: () => Promise<void>;
};

async function startFake(options: { rejectAuth?: boolean } = {}): Promise<Fake> {
  const transcript: string[] = [];
  const server: Server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    socket.write("220 fake.smtp ESMTP\r\n");
    let buffer = "";
    let inData = false;

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\r\n");
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 2.0.0 queued\r\n");
          }
          transcript.push(`DATA> ${line}`);
          continue;
        }

        transcript.push(line);
        if (line.startsWith("EHLO")) {
          socket.write("250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10240000\r\n");
        } else if (line.startsWith("AUTH PLAIN")) {
          socket.write(
            options.rejectAuth
              ? "535 5.7.8 authentication failed\r\n"
              : "235 2.7.0 accepted\r\n",
          );
        } else if (line.startsWith("AUTH LOGIN")) {
          socket.write("334 user\r\n");
        } else if (line.startsWith("MAIL FROM")) {
          socket.write("250 2.1.0 ok\r\n");
        } else if (line.startsWith("RCPT TO")) {
          socket.write("250 2.1.5 ok\r\n");
        } else if (line === "DATA") {
          inData = true;
          socket.write("354 end with .\r\n");
        } else if (line === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    transcript,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const config = (port: number) => ({
  host: "127.0.0.1",
  port,
  secure: false,
  starttls: false,
  from: "cabinet@example.test",
  timeoutMs: 5_000,
});

let running: Fake | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

describe("smtp config", () => {
  it("is null without a host, so callers can say not_configured", () => {
    expect(smtpConfigFromEnv({})).toBe(null);
    expect(smtpConfigFromEnv({ SMTP_HOST: "smtp.example.test" })).toBe(null);
  });

  it("derives the defaults from the transport", () => {
    const plain = smtpConfigFromEnv({
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM: "a@b.test",
    });
    expect(plain?.port).toBe(587);
    expect(plain?.secure).toBe(false);

    const tls = smtpConfigFromEnv({
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM: "a@b.test",
      SMTP_SECURE: "true",
    });
    expect(tls?.port).toBe(465);
    expect(tls?.secure).toBe(true);
  });

  it("falls back to the SMTP user as the sender", () => {
    const parsed = smtpConfigFromEnv({
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: "bot@example.test",
    });
    expect(parsed?.from).toBe("bot@example.test");
  });
});

describe("smtp delivery", () => {
  it("reports not_configured instead of throwing", async () => {
    const result = await sendEmail({ to: "u@example.test", subject: "s", text: "t" }, {
      config: null,
    });
    expect(result).toEqual({ status: "not_configured" });
  });

  it("sends a UTF-8 message through a real handshake", async () => {
    running = await startFake();

    const result = await sendEmail(
      {
        to: "u@example.test",
        subject: "验收未通过：检索任务",
        text: "第一行\n第二行",
      },
      { config: config(running.port) },
    );

    expect(result).toEqual({ status: "sent" });
    const transcript = running.transcript.join("\n");
    expect(transcript).toContain("EHLO");
    expect(transcript).toContain("MAIL FROM:<cabinet@example.test>");
    expect(transcript).toContain("RCPT TO:<u@example.test>");
    expect(transcript).toContain("DATA> Subject: =?UTF-8?B?");
    // Body is base64 so CJK survives every hop.
    expect(transcript).toContain("DATA> 56ys5LiA6KGM");
  });

  it("reads a multiline greeting and a multiline EHLO reply", async () => {
    running = await startFake();
    const result = await sendEmail(
      { to: "u@example.test", subject: "plain", text: "x" },
      { config: config(running.port) },
    );
    expect(result.status).toBe("sent");
  });

  it("returns failed with the server's reason when authentication is refused", async () => {
    running = await startFake({ rejectAuth: true });

    const result = await sendEmail(
      { to: "u@example.test", subject: "s", text: "t" },
      { config: { ...config(running.port), user: "bot", pass: "wrong" } },
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("535");
      expect(result.error).toContain("AUTH");
    }
  });

  it("fails cleanly when nothing is listening", async () => {
    const result = await sendEmail(
      { to: "u@example.test", subject: "s", text: "t" },
      { config: { ...config(9), host: "127.0.0.1", timeoutMs: 1_000 } },
    );
    expect(result.status).toBe("failed");
  });
});
