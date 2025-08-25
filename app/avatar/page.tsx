"use client";

import React from "react";
import AvatarCanvas from "../../components/AvatarCanvas";

export default function AvatarPage() {
  return (
    <main
      style={{
        maxWidth: 960,
        margin: "0 auto",
        padding: 16,
        color: "#eee",
        fontFamily:
          '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji"',
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
        🧍 ReadyPlayerMe — Viewer
      </h1>
      <p style={{ opacity: 0.8, marginBottom: 12 }}>
        A carregar GLB diretamente com <code>three.js</code>.
      </p>

      <div
        style={{
          width: "100%",
          height: 720,
          border: "1px solid #333",
          borderRadius: 12,
          background: "#0b0b0b",
          overflow: "hidden",
        }}
      >
        <AvatarCanvas />
      </div>
    </main>
  );
}
