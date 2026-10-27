// Minimal client for the app's control socket: newline-delimited JSON-RPC 2.0
// over a unix socket, mode 0600. The bridge has its own client in
// runtime/backends/host.js; this one exists so the bench does not depend on the
// bridge's internals, and so `bench/` stays readable on its own.
import { connect } from "node:net";

export class Control {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #buffer = "";
  #pushes = [];
  #closed = null;

  constructor(socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#absorb(chunk));
    this.#closed = new Promise((resolve) => socket.on("close", resolve));
    socket.on("error", () => {});
    for (const [id, entry] of this.#pending) {
      entry.reject(new Error("control socket closed"));
      this.#pending.delete(id);
    }
  }

  static connect(socketPath, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`control socket ${socketPath}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new Control(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  #absorb(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim() === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && this.#pending.has(message.id)) {
        const entry = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message ?? "control error");
          error.code = message.error.code;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
      } else if (message.method) {
        this.#pushes.push(message);
        if (this.#pushes.length > 500) this.#pushes.shift();
      }
    }
  }

  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    const id = this.#nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`control ${method}: no reply in ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.write(payload);
    });
  }

  /** Fire-and-forget: used for `quit`, where the reply is optional. */
  notify(method, params = {}) {
    this.#socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  get pushes() {
    return this.#pushes;
  }

  async close() {
    this.#socket.end();
    await Promise.race([this.#closed, new Promise((resolve) => setTimeout(resolve, 500))]);
    this.#socket.destroy();
  }
}
