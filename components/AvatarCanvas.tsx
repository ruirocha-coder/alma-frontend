"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, useGLTF, Environment } from "@react-three/drei";

// Verifica suporte WebGL no browser
function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(
      (c.getContext("webgl") as WebGLRenderingContext | null) ||
      (c.getContext("experimental-webgl") as WebGLRenderingContext | null)
    );
  } catch {
    return false;
  }
}

function AvatarModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  return <primitive object={scene} scale={1.35} position={[0, -1.2, 0]} />;
}

export default function AvatarCanvas({
  url,
  height = 720,
}: {
  url: string;
  height?: number;
}) {
  const [webgl, setWebgl] = useState<boolean>(true);

  // Preload do modelo (melhor UX)
  useEffect(() => {
    try {
      // @ts-ignore – a tipagem do drei permite isto
      useGLTF.preload(url);
    } catch {
      // ignora se não der preload
    }
  }, [url]);

  useEffect(() => {
    setWebgl(hasWebGL());
  }, []);

  const camera = useMemo(() => ({ position: [0, 1.6, 3] as [number, number, number], fov: 40 }), []);

  if (!webgl) {
    return (
      <div
        style={{
          width: "100%",
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#bbb",
          border: "1px solid #333",
          borderRadius: 12,
          background: "#0b0b0b",
          textAlign: "center",
          padding: 16,
        }}
      >
        O teu browser não suporta WebGL. Tenta no Chrome/Edge/Firefox atualizados.
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height }}>
      <Canvas camera={camera}>
        <ambientLight intensity={0.8} />
        <directionalLight position={[2, 5, 2]} intensity={1} />

        <Suspense fallback={null}>
          <AvatarModel url={url} />
          <Environment preset="city" />
        </Suspense>

        <OrbitControls enablePan={false} />
      </Canvas>
    </div>
  );
}
