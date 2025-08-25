"use client";

import React from "react";
import AvatarCanvas from "@/components/AvatarCanvas";

export default function Page() {
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>Avatar 3D</h1>
      <p style={{ opacity: 0.75, marginBottom: 12 }}>
        A carregar um modelo GLB (Ready Player Me). Sem splits, sem SSR.
      </p>
      <AvatarCanvas />
    </main>
  );
}
