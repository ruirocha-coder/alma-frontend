// lib/sttStreamClient.ts
// Cliente Web para o micro-serviço alma-stt-ws (Deepgram Realtime proxy)

export type TranscriptEvent = {
  transcript: string;
  isFinal: boolean;
};

type Callbacks = {
  onReady?: () => void;
  onTranscript?: (ev: TranscriptEvent) => void;
  onError?: (msg: string) => void;
  onClose?: () => void;
};

export class SttStreamer {
  private ws?: WebSocket;
  private ctx?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private stream?: MediaStream;
  private sending = false;

  constructor(
    private wsUrl: string,
    private cb: Callbacks = {},
    private desiredSampleRate = 16000,
  ) {}

  attachStream(stream: MediaStream) {
    this.stream = stream;
  }

  async start() {
    if (!this.wsUrl) {
      this.cb.onError?.("STT WS URL vazio.");
      return;
    }
    if (!this.stream) {
      this.cb.onError?.("Stream de micro ausente (chama requestMic primeiro).");
      return;
    }
    // 1) Abre WS
    this.ws = new WebSocket(this.wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      // 2) Abre AudioContext + ScriptProcessor
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 48000, // de costume os dispositivos vêm a 48 kHz
      });
      this.source = this.ctx.createMediaStreamSource(this.stream!);
      // ScriptProcessor é “legacy”, mas funciona universalmente (incl. iOS). 4096 frames ok.
      this.processor = this.ctx.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.sending || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0); // Float32 [-1..1] @ (p.ex.) 48 kHz
        const pcm16 = this.floatTo16BitPCM(input);
        const down = this.downsamplePCM(
          pcm16,
          this.ctx!.sampleRate,
          this.desiredSampleRate,
        );
        if (down && down.byteLength > 0) {
          this.ws.send(down.buffer);
        }
      };

      this.source.connect(this.processor);
      this.processor.connect(this.ctx.destination);
      this.sending = true;
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === "ready") this.cb.onReady?.();
        if (msg?.type === "transcript") {
          const t = (msg.transcript || "") as string;
          const isFinal = !!msg.isFinal;
          this.cb.onTranscript?.({ transcript: t, isFinal });
        }
        if (msg?.type === "error") {
          this.cb.onError?.(String(msg.message || "Erro STT"));
        }
      } catch (e: any) {
        // ignora parse de coisas que não nos interessem
      }
    };

    this.ws.onerror = (e: any) => {
      this.cb.onError?.("WebSocket STT erro.");
    };
    this.ws.onclose = () => {
      this.cb.onClose?.();
      this.cleanup();
    };
  }

  async stop() {
    // manda um “stop” textual (o proxy interpreta e fecha o stream no Deepgram)
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send("stop");
      }
    } catch {}
    try {
      this.ws?.close();
    } catch {}
    this.cleanup();
  }

  private cleanup() {
    try {
      this.sending = false;
      this.processor?.disconnect();
      this.source?.disconnect();
      // Não fechamos o AudioContext global do app se já houver um;
      try { this.ctx?.close(); } catch {}
    } catch {}
    this.processor = undefined;
    this.source = undefined;
    this.ctx = undefined;
    this.ws = undefined;
  }

  private floatTo16BitPCM(input: Float32Array) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let s = input[i];
      s = Math.max(-1, Math.min(1, s));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  // reamostragem linear muito simples (48 kHz -> 16 kHz, etc.)
  private downsamplePCM(
    input: Int16Array,
    inRate: number,
    outRate: number,
  ): Int16Array {
    if (outRate === inRate) return input;
    const ratio = inRate / outRate;
    const outLength = Math.floor(input.length / ratio);
    const result = new Int16Array(outLength);

    let inIdx = 0;
    let frac = 0;
    for (let i = 0; i < outLength; i++) {
      const idx = Math.floor(inIdx);
      const nextIdx = Math.min(idx + 1, input.length - 1);
      const t = frac;
      const v = input[idx] * (1 - t) + input[nextIdx] * t;
      result[i] = v;
      frac += ratio;
      while (frac >= 1) {
        frac -= 1;
        inIdx += 1;
      }
      inIdx += ratio - Math.floor(ratio);
    }
    return result;
  }
}
