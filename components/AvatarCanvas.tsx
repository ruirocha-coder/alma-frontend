"use client";

import { Canvas } from "@react-three/fiber";
import { Environment, OrbitControls, useGLTF } from "@react-three/drei";
import React, { Suspense, useMemo } from "react";

type Props = {
  url: string;
  height?: number;
  fov?: number;
};

function Model({ url }: { url: string }) {
  // @react-three/drei trata de fazer cache do GLTF
  const gltf = useGLTF(url, true);
  return <primitive object={gltf.scene} dispose={null} />;
}

// evita warnings do TS sobre GLTF loader
useGLTF.preload(
  "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb"
);

export default function AvatarCanvas({ url, height = 720, fov = 35 }: Props) {
  // clamp simples para viewport estável
  const canvasStyle = useMemo(
    () => ({
      width: "100%",
      height,
      border: "1px solid #333",
      borderRadius: 12,
      background: "#0b0b0b",
    }),
    [height]
  );

  return (
    <div style={canvasStyle}>
      <Canvas
        camera={{ position: [0, 1.4, 2.2], fov }}
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: false }}
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[3, 5, 2]} intensity={1.1} />

        <Suspense fallback={null}>
          <Model url={url} />
          <Environment preset="studio" />
        </Suspense>

        <OrbitControls
          enablePan={false}
          minDistance={1.2}
          maxDistance={3.5}
          minPolarAngle={Math.PI / 3.2}
          maxPolarAngle={(5 * Math.PI) / 6}
        />
      </Canvas>
    </div>
  );
}
