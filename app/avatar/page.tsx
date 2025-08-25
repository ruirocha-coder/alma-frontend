"use client";

import React from "react";
import dynamic from "next/dynamic";

const DynamicAvatarCanvas = dynamic(() => import("@/components/AvatarCanvas"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        width: "100%",
        height: 720,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#bbb",
        border: "1px solid #333",
        borderRadius: 12,
        background: "#0b0b0b",
      }}
    >
      A carregar o avatar…
    </div>
  ),
});

class ClientErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; msg?: string }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, msg: undefined };
  }
  static getDerivedStateFromError(err: any) {
    return { hasError: true, msg: err?.message || String(err) };
  }
  componentDidCatch(err: any) {
    console.error("Avatar client error:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: 16,
            border: "1px solid #333",
            borderRadius: 12,
            background: "#1a1a1a",
            color: "#eee",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            ⚠️ Erro a carregar o avatar
          </div>
          <div style={{ opacity: 0.8, whiteSpace: "pre-wrap" }}>
            {this.state.msg}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AvatarPage() {
  const url =
    process.env.NEXT_PUBLIC_AVATAR_URL ??
    "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb";

  return (
    <main
      style={{
        maxWidth: 960,
        margin: "0 auto",
        padding: 16,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial',
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
        🧍 Avatar (Ready Player Me)
      </h1>
      <p style={{ opacity: 0.8, marginBottom: 16 }}>
        Se não vires o avatar, abre a consola do browser: há normalmente
        detalhes do erro.
      </p>

      <ClientErrorBoundary>
        <DynamicAvatarCanvas url={url} height={720} />
      </ClientErrorBoundary>
    </main>
  );
}
