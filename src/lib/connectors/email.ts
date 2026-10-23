import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * A deliberately small SMTP client: no dependencies, no features beyond what a
 * transactional notice needs. If anything unexpected happens we return
 * `failed` with the server's reply — a mail layer that silently "succeeds" is
 * worse than one that refuses.
 */
export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  starttls: boolean;
  user?: string;
  pass?: string;
  from: string;
  timeoutMs: number;
};

export type EmailMessage = { to: string; subject: string; text: string };

export type EmailResult =
  | { status: "sent" }
  | { status: "not_configured" }
  | { status: "failed"; error: string };

export function smtpConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;

  const secure = (env.SMTP_SECURE ?? "").trim().toLowerCase() === "true";
  const from = env.SMTP_FROM?.trim() || env.SMTP_USER?.trim();
  if (!from) return null;

  const parsedPort = Number(env.SMTP_PORT ?? (secure ? 465 : 587));
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 587;
  const timeoutMs = Number(env.SMTP_TIMEOUT_MS ?? 10_000);

  return {
    host,
    port,
    secure,
    starttls: (env.SMTP_STARTTLS ?? "true").trim().toLowerCase() !== "false",
    user: env.SMTP_USER?.trim() || undefined,
    pass: env.SMTP_PASS || undefined,
    from,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
  };
}

export function smtpConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return smtpConfigFromEnv(env) !== null;
}

type Reply = { code: number; lines: string[] };

class SmtpFailure extends Error {}

class SmtpConnection {
  socket: Socket | TLSSocket;
  private buffer = "";
  private partial: string[] = [];
  private replies: Reply[] = [];
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null =
    null;
  private failure: Error | null = null;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  private detach() {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }

  private onData = (chunk: string) => {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.consume(line);
    }
  };

  private consume(line: string) {
    const match = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!match) {
      this.fail(new SmtpFailure(`SMTP 响应无法解析: ${line.slice(0, 80)}`));
      return;
    }
    const code = Number(match[1]);
    this.partial.push(match[3]);
    if (match[2] === "-") return; // continuation line
    const reply = { code, lines: this.partial };
    this.partial = [];
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(reply);
    } else {
      this.replies.push(reply);
    }
  }

  private onError = (error: Error) => this.fail(error);
  private onClose = () => this.fail(new SmtpFailure("SMTP 连接被关闭"));

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  async read(): Promise<Reply> {
    if (this.failure) throw this.failure;
    const queued = this.replies.shift();
    if (queued) return queued;
    return new Promise<Reply>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  async write(line: string) {
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve, reject) => {
      this.socket.write(`${line}\r\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  /** Writes a command and asserts the expected reply codes. */
  async command(line: string, expected: number[], redact?: string): Promise<Reply> {
    await this.write(line);
    const reply = await this.read();
    if (!expected.includes(reply.code)) {
      throw new SmtpFailure(
        `${redact ?? line.split(" ")[0]} 被拒绝：${reply.code} ${reply.lines.join(" ")}`,
      );
    }
    return reply;
  }

  detachAndHandOff(socket: TLSSocket) {
    this.detach();
    this.socket = socket;
    this.attach(socket);
  }

  end() {
    this.detach();
    this.socket.end();
  }
}

function encodeSubject(subject: string): string {
  // RFC 2047: non-ASCII subjects must be encoded or they arrive as mojibake.
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function buildMessage(config: SmtpConfig, message: EmailMessage): string {
  const body = Buffer.from(message.text, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${config.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeSubject(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

/** SMTP terminates the message body with a lone dot; content dots must be doubled. */
function dotStuff(message: string): string {
  return message.replace(/\r\n\./g, "\r\n..");
}

async function authenticate(
  connection: SmtpConnection,
  config: SmtpConfig,
  capabilities: string,
): Promise<void> {
  if (!config.user || !config.pass) return;

  const supportsPlain = /AUTH[ =][^\r\n]*PLAIN/i.test(capabilities);
  const supportsLogin = /AUTH[ =][^\r\n]*LOGIN/i.test(capabilities);

  if (supportsPlain || !supportsLogin) {
    const token = Buffer.from(`\0${config.user}\0${config.pass}`, "utf8").toString(
      "base64",
    );
    await connection.command(`AUTH PLAIN ${token}`, [235], "AUTH");
    return;
  }

  await connection.command("AUTH LOGIN", [334], "AUTH");
  await connection.command(
    Buffer.from(config.user, "utf8").toString("base64"),
    [334],
    "AUTH",
  );
  await connection.command(
    Buffer.from(config.pass, "utf8").toString("base64"),
    [235],
    "AUTH",
  );
}

function connectSocket(config: SmtpConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tlsConnect({
          host: config.host,
          port: config.port,
          servername: config.host,
          timeout: config.timeoutMs,
        })
      : netConnect({ host: config.host, port: config.port, timeout: config.timeoutMs });

    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once(config.secure ? "secureConnect" : "connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
    socket.setTimeout(config.timeoutMs, () => {
      socket.destroy();
      reject(new SmtpFailure(`连接 ${config.host}:${config.port} 超时`));
    });
  });
}

export async function sendEmail(
  message: EmailMessage,
  options: { config?: SmtpConfig | null; env?: Record<string, string | undefined> } = {},
): Promise<EmailResult> {
  const config =
    options.config === undefined
      ? smtpConfigFromEnv(options.env ?? process.env)
      : options.config;
  if (!config) return { status: "not_configured" };

  let connection: SmtpConnection | null = null;
  try {
    const socket = await connectSocket(config);
    connection = new SmtpConnection(socket);

    const greeting = await connection.read();
    if (greeting.code !== 220) {
      throw new SmtpFailure(`服务端拒绝连接：${greeting.code} ${greeting.lines.join(" ")}`);
    }

    const hostname = config.from.split("@")[1] ?? "localhost";
    let ehlo = await connection.command(`EHLO ${hostname}`, [250]);
    let capabilities = ehlo.lines.join("\n");

    if (!config.secure && config.starttls && /STARTTLS/i.test(capabilities)) {
      await connection.command("STARTTLS", [220]);
      const upgraded = tlsConnect({
        socket: connection.socket,
        servername: config.host,
        timeout: config.timeoutMs,
      });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", () => resolve());
        upgraded.once("error", reject);
      });
      connection.detachAndHandOff(upgraded);
      ehlo = await connection.command(`EHLO ${hostname}`, [250]);
      capabilities = ehlo.lines.join("\n");
    }

    await authenticate(connection, config, capabilities);
    await connection.command(`MAIL FROM:<${config.from}>`, [250]);
    await connection.command(`RCPT TO:<${message.to}>`, [250, 251]);
    await connection.command("DATA", [354]);
    await connection.write(dotStuff(buildMessage(config, message)));
    await connection.command(".", [250]);
    await connection.command("QUIT", [221]).catch(() => undefined);

    connection.end();
    return { status: "sent" };
  } catch (error) {
    connection?.end();
    const message_ = error instanceof Error ? error.message : String(error);
    return { status: "failed", error: message_ };
  }
}
