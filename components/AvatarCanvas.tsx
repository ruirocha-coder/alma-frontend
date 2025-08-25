"use client";

import React, { Suspense, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Environment,
  ContactShadows,
  Html,
  useProgress,
  useGLTF,
} from "@react-three/drei";

type AvatarCanvasProps = {
  glbUrl: string;
  autoRotate?: boolean;
  zoom?: number; // 1 = perto, 2 = mais longe
};

function Loader() {
  const { progress } = useProgress();
  return (
    <Html center style={{ color: "#fff", fontSize: 14 }}>
      {`A carregar… ${progress.toFixed(0)}%`}
    </Html>
  );
}

function AvatarModel({ url }: { url: string }) {
  // Ready Player Me usa GLB (Y-up, escala em metros)
  const { scene } = useGLTF(url, true);
  // Ajustes suaves para caber na cena
  const model = useMemo(() => {
    const s = scene.clone();
    s.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    s.position.set(0, -1.05, 0); // descer um bocadinho
    s.scale.setScalar(1.05);
    return s;
  }, [scene]);
  return <primitive object={model} />;
}

export default function AvatarCanvas({
  glbUrl,
  autoRotate = true,
  zoom = 1.4,
}: AvatarCanvasProps) {
  return (
    <div
      style={{
        width: "100%",
        aspectRatio: "16/9",
        background: "#0a0a0a",
        border: "1px solid #222",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [0, 1.25, 2.25 * zoom], fov: 35 }}
      >
        <ambientLight intensity={0.8} />
        <directionalLight
          position={[3, 4, 2]}
          intensity={1.2}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <Suspense fallback={<Loader />}>
          <AvatarModel url={glbUrl} />
          <ContactShadows
            position={[0, -1.1, 0]}
            scale={4}
            blur={2.5}
            opacity={0.4}
          />
          <Environment preset="studio" />
        </Suspense>
        <OrbitControls
          enablePan={false}
          enableZoom={false}
          autoRotate={autoRotate}
          autoRotateSpeed={0.8}
          minPolarAngle={Math.PI * 0.35}
          maxPolarAngle={Math.PI * 0.55}
        />
      </Canvas>
    </div>
  );
}

// Opcional: para acelerar carregamentos futuros quando o URL for fixo
// useGLTF.preload("https://models.readyplayer.me/68ac391e858e75812baf48c2.glb");
