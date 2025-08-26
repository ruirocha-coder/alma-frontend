import { NextRequest } from "next/server";

export const config = {
  runtime: "edge", // precisa de edge runtime para WebSocket
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dgKey = process.env.DEEPGRAM_API_KEY;

  if (!dgKey) {
    return new Response("⚠️ DEEPGRAM_API_KEY não definida", { status: 500 });
  }

  // Abre WebSocket com Deepgram
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected websocket", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    console.log("🔌 Cliente ligado ao proxy STT");
  };

  // encaminha mensagens entre cliente e Deepgram
  const dgWs = new WebSocket(
    "wss://api.deepgram.com/v1/listen?model=nova-2&language=pt",
    { headers: { Authorization: `Token ${dgKey}` } } as any
  );

  dgWs.onmessage = (event) => {
    socket.send(event.data);
  };
  dgWs.onerror = (err) => {
    console.error("Erro Deepgram WS", err);
    try {
      socket.close();
    } catch {}
  };

  socket.onmessage = (event) => {
    dgWs.send(event.data);
  };
  socket.onclose = () => {
    dgWs.close();
  };

  return response;
}
