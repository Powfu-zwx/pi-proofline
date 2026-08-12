// Minimal OpenAI-compatible chat completions mock for end-to-end tests.
// Streams a fixed assistant reply over SSE and reports usage.

import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? 8377);

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.on("data", (piece) => {
    body += piece;
  });
  request.on("end", () => {
    const base = {
      id: "chatcmpl-mock-1",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-mock",
    };
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.write(
      sseChunk({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: "Hello from the mock." }, finish_reason: null }],
      }),
    );
    response.write(
      sseChunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      }),
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock provider listening on http://127.0.0.1:${port}/v1`);
});
