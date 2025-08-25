"use client";

import React, { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, useGLTF, Environment } from "@react-three/drei";

function AvatarModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);

  // aplica escala manual para o avatar não ficar pequeno
  return <primitive object={scene} scale={1.3} position={[0, -1.2, 0]} />;
}

export default function AvatarCanvas({
  url,
  height = 720,
}: {
  url: string;
  height?: number;
}) {
  return (
    <div style={{ width: "100%", height }}>
      <Canvas camera={{ position: [0, 1.6, 3], fov: 40 }}>
        {/* luzes */}
        <ambientLight intensity={0.8} />
        <directionalLight position={[2, 5, 2]} intensity={1} />

        {/* ambiente realista */}
        <Suspense fallback={null}>
          <AvatarModel url={url} />
          <Environment preset="city" />
        </Suspense>

        {/* controlo de orbitas */}
        <OrbitControls enablePan={false} />
      </Canvas>
    </div>
  );
}
